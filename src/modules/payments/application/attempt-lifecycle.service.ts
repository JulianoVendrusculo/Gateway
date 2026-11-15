import { Injectable, Logger } from '@nestjs/common';
import { Convenio, Merchant, PaymentMethod, Prisma, Transaction, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { BankIntegrationError, BankRejectedError, ResourceNotFoundError } from '../../../common/errors';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ChargeReference, ChargeStatusResult, GatewayContext, IPaymentGateway, ProviderPayment } from '../domain/payment-gateway.port';
import { SYNCABLE_STATUSES, assertTransition, isActive } from '../domain/transaction-state-machine';
import { PaymentGatewayRegistry } from '../gateways/payment-gateway.registry';
import { ChargeRepository } from './charge.repository';
import { GatewayContextFactory } from './gateway-context.factory';
import { CANCEL_REASON, PaymentSettlementService, SettlementResult } from './payment-settlement.service';

const S = TransactionStatus;

const SYNC_CLAIM_MS = 60_000;
/** Tentativa PROCESSANDO que o provedor desconhece depois deste prazo nunca chegou a ser registrada. */
const NOT_FOUND_GRACE_MS = 15 * 60_000;
/** Uma troca de método marcada há mais tempo que isto foi abandonada (o processo caiu no meio). */
export const METHOD_SWITCH_LEASE_MS = 2 * 60_000;

type LoadedTransaction = Transaction & { convenio: Convenio; merchant: Merchant };

/** O que fazer com uma tentativa diante do que o provedor informou. Função pura: ver `decide`. */
type Action = 'SETTLE' | 'REGISTER' | 'CANCEL' | 'VERIFY' | 'EXPIRE' | 'NONE';

export interface AdvanceOutcome {
  transaction: Transaction;
  changed: boolean;
  providerStatus?: string;
  settlements: SettlementResult[];
}

export type CancelOutcome =
  /** Cancelamento confirmado pelo banco (ou a tentativa deixou de bloquear a Charge). */
  | { kind: 'CANCELED' }
  /** O banco informou que a tentativa foi paga: o pagamento foi registrado. */
  | { kind: 'PAID' }
  /** A tentativa continua ativa. `limitation` = o banco não oferece cancelamento para ela. */
  | { kind: 'REFUSED'; reason: string; limitation: boolean; activeUntil: Date | null }
  | { kind: 'ERROR'; error: BankIntegrationError }
  /** Nada a cancelar (a tentativa já não estava ativa ou ainda não existe no banco). */
  | { kind: 'SKIPPED' };

export interface AdvanceOptions {
  /** Pagamento informado por um webhook: identifica o pagamento quando a consulta ao provedor não o faz. */
  eventPayment?: ProviderPayment;
  /** Consulta também tentativas já pagas (para detectar um segundo pagamento da mesma tentativa). */
  includeSettled?: boolean;
}

/**
 * Ciclo de vida de uma tentativa a partir do que o BANCO diz. Webhook, job e ?refresh=true passam por aqui.
 * Nenhum deles altera status por conta própria: consultam o provedor (getStatus) e aplicam o resultado
 * com a Charge bloqueada.
 */
@Injectable()
export class AttemptLifecycleService {
  private readonly logger = new Logger(AttemptLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly charges: ChargeRepository,
    private readonly registry: PaymentGatewayRegistry,
    private readonly contextFactory: GatewayContextFactory,
    private readonly settlement: PaymentSettlementService,
    private readonly config: AppConfig,
  ) {}

  /** Consulta o provedor e aplica o que ele informar: confirma, registra, cancela, verifica ou expira. */
  async advance(transactionId: string, source: TransactionEventSource, options: AdvanceOptions = {}): Promise<AdvanceOutcome> {
    const tx = await this.load(transactionId);
    const unchanged: AdvanceOutcome = { transaction: tx, changed: false, settlements: [] };
    // Transações da v1 (sem Charge) não são gerenciadas pela v2.
    if (!tx.chargeId || !tx.providerReference) return unchanged;
    const settled = tx.status === S.CONFIRMADA || tx.status === S.PAGO_DUPLICADO;
    if (!(SYNCABLE_STATUSES as readonly TransactionStatus[]).includes(tx.status) && !(options.includeSettled && settled)) return unchanged;
    // O claim evita que várias instâncias consultem o banco pela mesma transação. Um webhook que traz
    // um pagamento não pode ser descartado por isso: ele segue, e a Charge bloqueada garante a ordem.
    const claimed = await this.claim(tx);
    if (!claimed && !options.eventPayment) return unchanged;

    try {
      const { gateway, ctx, ref } = this.gatewayFor(tx);
      let status: ChargeStatusResult;
      try {
        status = await gateway.getStatus(ctx, ref);
      } catch (err) {
        if (this.neverRegistered(tx, err)) return await this.failNeverRegistered(tx, source);
        throw err;
      }

      // Último passo antes de liberar uma tentativa vencida: se o banco ainda a aceita, tenta invalidá-la.
      if (this.decide(tx, status, new Date()) === 'EXPIRE' && status.status === S.PENDENTE) {
        const cancel = await gateway.cancel(ctx, ref);
        if (cancel.outcome === 'ALREADY_PAID') {
          status = { status: S.CONFIRMADA, providerStatus: cancel.providerStatus, payments: cancel.payments };
        } else if (cancel.outcome !== 'CANCELED') {
          // Limitação conhecida: a tentativa é liberada do nosso lado, mas o banco ainda aceitaria o pagamento.
          // Se ele vier, é registrado como pagamento tardio (confirma a Charge ou vira PAGO_DUPLICADO).
          this.logger.warn({ msg: 'attempt expired but still payable at provider', transactionId: tx.id, method: tx.method, cancelOutcome: cancel.outcome });
        }
      }
      return await this.apply(tx, status, source, options.eventPayment);
    } finally {
      if (claimed) await this.prisma.transaction.updateMany({ where: { id: tx.id }, data: { syncLockedUntil: null } });
    }
  }

  /**
   * Pede o cancelamento no banco e só considera cancelado depois de o banco CONFIRMAR (getStatus).
   * Usado na troca de método e para derrubar as outras tentativas quando a Charge é paga.
   */
  async cancelAtProvider(transactionId: string, source: TransactionEventSource): Promise<CancelOutcome> {
    const tx = await this.load(transactionId);
    if (!tx.chargeId || !isActive(tx.status)) return { kind: 'SKIPPED' };
    // Criação ainda sem resposta do banco: não há o que cancelar agora (o job volta quando ela se resolver).
    if (tx.status === S.PROCESSANDO || !tx.providerReference) return { kind: 'SKIPPED' };

    const { gateway, ctx, ref } = this.gatewayFor(tx);
    const result = await gateway.cancel(ctx, ref);
    if (result.outcome === 'TECHNICAL_ERROR') return this.cancelFailed(tx, result.error, source);

    let status: ChargeStatusResult | undefined;
    if (result.outcome === 'ALREADY_PAID') {
      status = { status: S.CONFIRMADA, providerStatus: result.providerStatus, payments: result.payments };
    } else if (result.outcome !== 'NOT_SUPPORTED') {
      try {
        status = await gateway.getStatus(ctx, ref);
      } catch (err) {
        if (err instanceof BankIntegrationError) return this.cancelFailed(tx, err, source);
        throw err;
      }
    }

    if (status && status.status !== S.PENDENTE) {
      // Pago, cancelado ou vencido no banco: o caminho normal resolve (inclusive a janela de verificação).
      const outcome = await this.apply(tx, status, source);
      if (status.status === S.CONFIRMADA) return { kind: 'PAID' };
      if (!isActive(outcome.transaction.status)) return { kind: 'CANCELED' };
      return { kind: 'REFUSED', reason: 'a tentativa venceu e está em verificação no banco', limitation: false, activeUntil: outcome.transaction.verificationUntil };
    }

    // O banco continua aceitando o pagamento: a tentativa segue ativa.
    const limitation = result.outcome === 'NOT_SUPPORTED';
    const reason =
      result.outcome === 'NOT_SUPPORTED'
        ? result.reason
        : result.outcome === 'REFUSED'
          ? (result.reason ?? 'o banco recusou o cancelamento')
          : 'o banco ainda não confirmou o cancelamento';
    // Pedido aceito mas ainda não efetivado, com a Charge já paga: mantém a marcação para o job insistir.
    const keepRetrying = tx.cancelReason === CANCEL_REASON.CHARGE_PAID && result.outcome === 'CANCELED';
    const updated = await this.charges.withLockedCharge(tx.chargeId, async (db) => {
      const cur = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      if (!isActive(cur.status)) return cur;
      await db.transactionEvent.create({
        data: { transactionId: tx.id, type: limitation ? 'cancel.unsupported' : 'cancel.refused', source, data: { reason, cancelReason: cur.cancelReason, providerStatus: status?.providerStatus ?? null } },
      });
      return db.transaction.update({
        where: { id: tx.id },
        data: keepRetrying ? { cancelAttempts: { increment: 1 }, lastSyncedAt: new Date() } : { cancelRequestedAt: null, cancelReason: null, lastSyncedAt: new Date() },
      });
    });
    if (limitation) {
      this.logger.warn({ msg: 'provider offers no cancellation; attempt stays active until it expires', transactionId: tx.id, method: tx.method, activeUntil: updated.expiresAt });
    }
    return { kind: 'REFUSED', reason, limitation, activeUntil: updated.expiresAt };
  }

  /** Cancela no banco as tentativas que perderam para um pagamento confirmado. Falhas ficam para o job repetir. */
  async releaseSuperseded(transactions: Array<{ id: string }>, source: TransactionEventSource): Promise<void> {
    for (const { id } of transactions) {
      try {
        const outcome = await this.cancelAtProvider(id, source);
        this.logger.log({ msg: 'superseded attempt cancel', transactionId: id, outcome: outcome.kind });
      } catch (err) {
        this.logger.error({ msg: 'superseded attempt cancel failed; will be retried', transactionId: id, err });
      }
    }
  }

  /** Modo sem reconsulta (WEBHOOK_CONFIRM_WITH_PROVIDER=false): confia no evento. Só para ambientes controlados. */
  async settleTrusted(transactionId: string, payment: ProviderPayment, source: TransactionEventSource): Promise<AdvanceOutcome> {
    const tx = await this.load(transactionId);
    if (!tx.chargeId) return { transaction: tx, changed: false, settlements: [] };
    return this.apply(tx, { status: S.CONFIRMADA, providerStatus: 'WEBHOOK_TRUSTED', payments: [payment] }, source);
  }

  /**
   * Decide o que fazer com a tentativa. Regras de vencimento:
   *  - vencida não é liberada na hora: fica EM_VERIFICACAO pela janela de tolerância do método
   *    (a confirmação do banco pode chegar atrasada) e continua bloqueando a Charge;
   *  - só depois da janela vira EXPIRADA.
   */
  decide(cur: Transaction, status: ChargeStatusResult, now: Date): Action {
    if (status.status === S.CONFIRMADA) return 'SETTLE';
    if (!isActive(cur.status)) return 'NONE';
    if (status.status === S.CANCELADA) return 'CANCEL';
    if (cur.status === S.PROCESSANDO) return 'REGISTER';
    if (cur.status === S.EM_VERIFICACAO) return cur.verificationUntil && cur.verificationUntil > now ? 'NONE' : 'EXPIRE';

    const expired = status.status === S.EXPIRADA || (cur.expiresAt !== null && cur.expiresAt <= now);
    if (!expired) return 'NONE';
    return this.verificationDeadline(cur, now) > now ? 'VERIFY' : 'EXPIRE';
  }

  verificationDeadline(cur: Pick<Transaction, 'method' | 'expiresAt'>, now: Date): Date {
    return new Date((cur.expiresAt ?? now).getTime() + this.verificationWindowSeconds(cur.method) * 1000);
  }

  private verificationWindowSeconds(method: PaymentMethod): number {
    if (method === PaymentMethod.PIX) return this.config.get('VERIFICATION_WINDOW_PIX_SECONDS');
    if (method === PaymentMethod.BOLETO) return this.config.get('VERIFICATION_WINDOW_BOLETO_SECONDS');
    return this.config.get('VERIFICATION_WINDOW_CARD_SECONDS');
  }

  // ---------------------------------------------------------------------------

  private async apply(tx: LoadedTransaction, status: ChargeStatusResult, source: TransactionEventSource, eventPayment?: ProviderPayment): Promise<AdvanceOutcome> {
    const now = new Date();
    const outcome = await this.charges.withLockedCharge(tx.chargeId!, async (db): Promise<AdvanceOutcome> => {
      const cur = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      const action = this.decide(cur, status, now);
      const base = { providerStatus: status.providerStatus };

      if (action === 'SETTLE') {
        const settlements: SettlementResult[] = [];
        for (const payment of paymentsFor(status, eventPayment)) {
          settlements.push(await this.settlement.settle(db, cur.id, { ...payment, source, providerStatus: status.providerStatus }));
        }
        if (cur.providerData === null && status.providerData) {
          await db.transaction.update({ where: { id: cur.id }, data: { providerData: status.providerData as Prisma.InputJsonObject } });
        }
        const transaction = await db.transaction.findUniqueOrThrow({ where: { id: cur.id } });
        return { ...base, transaction, changed: settlements.some((s) => s.kind !== 'ALREADY_SETTLED'), settlements };
      }

      const patch = this.patchFor(action, cur, status, now);
      if (!patch) {
        // Troca de método abandonada (o processo caiu no meio): a tentativa volta a valer normalmente.
        const staleSwitch = cur.cancelReason === CANCEL_REASON.METHOD_SWITCH && cur.cancelRequestedAt !== null && now.getTime() - cur.cancelRequestedAt.getTime() > METHOD_SWITCH_LEASE_MS;
        const transaction = await db.transaction.update({
          where: { id: cur.id },
          data: { lastSyncedAt: now, ...(staleSwitch ? { cancelRequestedAt: null, cancelReason: null } : {}) },
        });
        return { ...base, transaction, changed: false, settlements: [] };
      }
      assertTransition(cur.status, patch.data.status);
      const transaction = await db.transaction.update({ where: { id: cur.id }, data: { ...patch.data, lastSyncedAt: now, version: { increment: 1 } } });
      await db.transactionEvent.create({
        data: { transactionId: cur.id, type: patch.event, fromStatus: cur.status, toStatus: transaction.status, source, data: { providerStatus: status.providerStatus, ...patch.eventData } },
      });
      this.logger.log({ msg: 'attempt status changed', transactionId: cur.id, from: cur.status, to: transaction.status, source });
      return { ...base, transaction, changed: true, settlements: [] };
    });

    const superseded = outcome.settlements.flatMap((s) => (s.kind === 'CONFIRMED' ? s.superseded : []));
    if (superseded.length > 0) await this.releaseSuperseded(superseded, source);
    return outcome;
  }

  private patchFor(action: Exclude<Action, 'SETTLE'>, cur: Transaction, status: ChargeStatusResult, now: Date) {
    const cleared = { verificationUntil: null, cancelRequestedAt: null, cancelReason: null };
    switch (action) {
      case 'REGISTER':
        // Criação de resultado incerto que o banco confirma ter registrado: completa os dados da cobrança.
        return {
          event: 'charge.registered',
          eventData: { reconciled: true },
          data: {
            status: S.PENDENTE,
            ...(cur.providerData === null && status.providerData ? { providerData: status.providerData as Prisma.InputJsonObject } : {}),
            ...(cur.expiresAt === null && status.expiresAt ? { expiresAt: status.expiresAt } : {}),
          },
        };
      case 'CANCEL':
        return { event: 'attempt.canceled', eventData: { cancelReason: cur.cancelReason }, data: { status: S.CANCELADA, ...cleared } };
      case 'VERIFY': {
        const verificationUntil = this.verificationDeadline(cur, now);
        return { event: 'attempt.verifying', eventData: { verificationUntil: verificationUntil.toISOString() }, data: { status: S.EM_VERIFICACAO, verificationUntil } };
      }
      case 'EXPIRE':
        return { event: 'attempt.expired', eventData: {}, data: { status: S.EXPIRADA, ...cleared } };
      case 'NONE':
        return undefined;
    }
  }

  /** Falha técnica ao cancelar. Na troca de método a tentativa volta a valer; com a Charge paga, o job repete. */
  private async cancelFailed(tx: LoadedTransaction, error: BankIntegrationError, source: TransactionEventSource): Promise<CancelOutcome> {
    const retry = tx.cancelReason === CANCEL_REASON.CHARGE_PAID;
    await this.charges.withLockedCharge(tx.chargeId!, async (db) => {
      await db.transaction.updateMany({
        where: { id: tx.id },
        data: retry ? { cancelAttempts: { increment: 1 }, lastSyncedAt: new Date() } : { cancelRequestedAt: null, cancelReason: null },
      });
      await db.transactionEvent.create({ data: { transactionId: tx.id, type: 'cancel.failed', source, data: { code: error.code, outcome: error.outcome, willRetry: retry } } });
    });
    const log = { msg: 'attempt cancel failed', transactionId: tx.id, method: tx.method, code: error.code, willRetry: retry, cancelAttempts: tx.cancelAttempts + 1 };
    if (retry && tx.cancelAttempts + 1 >= 5) this.logger.error({ ...log, alert: 'CANCELAMENTO_PENDENTE' });
    else this.logger.warn(log);
    return { kind: 'ERROR', error };
  }

  private neverRegistered(tx: Transaction, err: unknown): boolean {
    return tx.status === S.PROCESSANDO && err instanceof BankRejectedError && err.bankHttpStatus === 404 && Date.now() - tx.createdAt.getTime() > NOT_FOUND_GRACE_MS;
  }

  private async failNeverRegistered(tx: LoadedTransaction, source: TransactionEventSource): Promise<AdvanceOutcome> {
    this.logger.warn({ msg: 'uncertain charge not found at provider; marking FALHOU', transactionId: tx.id });
    const transaction = await this.charges.withLockedCharge(tx.chargeId!, async (db) => {
      const cur = await db.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      if (cur.status !== S.PROCESSANDO) return cur;
      await db.transactionEvent.create({ data: { transactionId: tx.id, type: 'charge.failed', fromStatus: cur.status, toStatus: S.FALHOU, source, data: { reason: 'not_found_at_provider' } } });
      return db.transaction.update({
        where: { id: tx.id },
        data: { status: S.FALHOU, failureCode: 'NOT_REGISTERED_AT_PROVIDER', failureMessage: 'A cobrança não foi registrada no provedor', cancelRequestedAt: null, cancelReason: null, lastSyncedAt: new Date(), version: { increment: 1 } },
      });
    });
    return { transaction, changed: true, settlements: [] };
  }

  private gatewayFor(tx: LoadedTransaction): { gateway: IPaymentGateway; ctx: GatewayContext; ref: ChargeReference } {
    return {
      gateway: this.registry.get(tx.provider),
      ctx: this.contextFactory.build(tx.convenio, { name: tx.merchant.name, document: tx.merchant.document }),
      ref: { transactionId: tx.id, method: tx.method, providerReference: tx.providerReference!, amountCents: tx.amountCents, createdAt: tx.createdAt, expiresAt: tx.expiresAt },
    };
  }

  private async load(transactionId: string): Promise<LoadedTransaction> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId }, include: { convenio: true, merchant: true } });
    if (!tx) throw new ResourceNotFoundError('Transação');
    return tx;
  }

  /** Claim otimista por linha: evita que várias instâncias consultem o banco para a mesma transação. */
  private async claim(tx: Transaction): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.transaction.updateMany({
      where: { id: tx.id, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: now } }] },
      data: { syncLockedUntil: new Date(now.getTime() + SYNC_CLAIM_MS) },
    });
    return count === 1;
  }
}

/**
 * Pagamentos a registrar. Se a consulta ao provedor identifica cada pagamento (Pix, link de cartão),
 * vale a lista dela. Se não identifica (boleto), o identificador vem do evento que disparou a consulta.
 */
function paymentsFor(status: ChargeStatusResult, eventPayment?: ProviderPayment): ProviderPayment[] {
  const reported = status.payments?.length ? status.payments : [{}];
  if (eventPayment?.id && !reported.some((p) => p.id)) {
    const [first] = reported;
    return [{ id: eventPayment.id, amountCents: first.amountCents ?? eventPayment.amountCents, paidAt: first.paidAt ?? eventPayment.paidAt }];
  }
  return reported;
}
