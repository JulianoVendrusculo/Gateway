import { Injectable, Logger } from '@nestjs/common';
import { Charge, ChargeStatus, Convenio, Customer, PaymentMethod, Prisma, Transaction, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  AttemptInProgressError,
  BankIntegrationError,
  CancellationRefusedError,
  ChargeAmountMismatchError,
  ChargeClosedError,
  IdempotencyKeyReusedError,
  PaymentAlreadyConfirmedError,
  UnexpectedProcessingError,
  UnsupportedPaymentMethodError,
  ValidationError,
} from '../../../common/errors';
import { diffInDays, endOfCivilDayBr, parseIsoDate, todayBr } from '../../../common/utils/date-helpers';
import { AppConfig } from '../../../config/app-config';
import { isUniqueViolation } from '../../../infra/database/prisma.service';
import { AuthenticatedMerchant } from '../../auth/authenticated-merchant';
import { ConveniosService } from '../../convenios/convenios.service';
import { CustomerInput, CustomersService } from '../../customers/customers.service';
import { CardMode, ChargeRequest, ChargeResult, GatewayContext, IPaymentGateway, PayerData } from '../domain/payment-gateway.port';
import { ACTIVE_STATUSES } from '../domain/transaction-state-machine';
import { PaymentGatewayRegistry } from '../gateways/payment-gateway.registry';
import { AttemptLifecycleService, METHOD_SWITCH_LEASE_MS } from './attempt-lifecycle.service';
import { ChargeRepository, Db } from './charge.repository';
import { ConvenioResolver } from './convenio-resolver';
import { GatewayContextFactory } from './gateway-context.factory';
import { PaymentPresenter, PaymentView } from './payment.presenter';
import { CANCEL_REASON, PaymentSettlementService } from './payment-settlement.service';

const S = TransactionStatus;

export interface CreatePaymentCommand {
  merchant: AuthenticatedMerchant;
  idempotencyKey: string;
  /** Id da inscrição: identifica a cobrança única. */
  externalReference: string;
  method: PaymentMethod;
  amountCents: number;
  description?: string;
  convenioId?: string;
  /** Prazo da cobrança. Só é usado quando ela é criada (primeira tentativa da inscrição). */
  chargeExpiresAt?: Date;
  customer: CustomerInput;
  pix?: { expiresInSeconds: number };
  boleto?: {
    dueDate: string;
    instructions: string[];
    finePercent?: number;
    interestMonthlyPercent?: number;
    acceptUntilDaysAfterDue?: number;
  };
  card?: { mode: CardMode; maxInstallments: number; softDescriptor?: string };
  metadata?: Record<string, string | number | boolean>;
}

export interface CreatePaymentResult {
  view: PaymentView;
  /** false quando a requisição devolveu a tentativa que já estava ativa (mesmo boleto, mesmo QR, mesmo link). */
  created: boolean;
}

type AttemptWithCustomer = Transaction & { customer: Customer };

type Decision =
  | { kind: 'REUSE'; attempt: AttemptWithCustomer }
  | { kind: 'CREATE'; attempt: Transaction; request: ChargeRequest }
  | { kind: 'SWITCH'; attempt: AttemptWithCustomer }
  | { kind: 'RESOLVE_EXPIRED'; attempt: AttemptWithCustomer };

interface Target {
  convenio: Convenio;
  gateway: IPaymentGateway;
  ctx: GatewayContext;
  customer: Customer;
  payer: PayerData;
}

const MAX_BOLETO_DAYS_AHEAD = 5 * 365;
const DEFAULT_PIX_EXPIRATION = 3600;

/**
 * Cria (ou devolve) a tentativa de pagamento de uma cobrança única.
 *
 * Cada passo de decisão roda com a linha da Charge bloqueada (SELECT ... FOR UPDATE):
 *   1. Charge PAGA                         -> 409 PAGAMENTO_JA_CONFIRMADO
 *   2. sem tentativa ativa                 -> grava a tentativa (PROCESSANDO) e chama o banco
 *   3. tentativa ativa do MESMO método     -> devolve a mesma (mesmo boleto, mesmo QR Code, mesmo link)
 *   4. tentativa ativa de OUTRO método     -> cancela no banco, espera a CONFIRMAÇÃO e só então cria a nova;
 *                                             cancelamento recusado -> 409 CANCELAMENTO_RECUSADO
 *   5. tentativa em criação ou em verificação -> 409 TENTATIVA_EM_ANDAMENTO
 *
 * As chamadas ao banco ficam FORA do lock (ver ChargeRepository). O que impede duas tentativas
 * simultâneas nesse intervalo é a própria tentativa gravada como ativa, mais o índice único parcial.
 */
@Injectable()
export class ProcessPaymentUseCase {
  private readonly logger = new Logger(ProcessPaymentUseCase.name);

  constructor(
    private readonly resolver: ConvenioResolver,
    private readonly registry: PaymentGatewayRegistry,
    private readonly contextFactory: GatewayContextFactory,
    private readonly convenios: ConveniosService,
    private readonly customers: CustomersService,
    private readonly charges: ChargeRepository,
    private readonly lifecycle: AttemptLifecycleService,
    private readonly settlement: PaymentSettlementService,
    private readonly presenter: PaymentPresenter,
    private readonly config: AppConfig,
  ) {}

  async execute(cmd: CreatePaymentCommand): Promise<CreatePaymentResult> {
    this.validateBusinessRules(cmd);

    const convenio = await this.resolver.resolve(cmd.merchant.id, cmd.method, cmd.convenioId);
    const gateway = this.registry.forMethod(convenio.provider, cmd.method);
    if (cmd.method === PaymentMethod.CREDIT_CARD && !gateway.cardModes?.has(cmd.card!.mode)) {
      throw new UnsupportedPaymentMethodError(convenio.provider, `CREDIT_CARD/${cmd.card!.mode}`);
    }
    // Contexto montado antes de qualquer efeito colateral: convênio quebrado falha cedo.
    const ctx = this.contextFactory.build(convenio, { name: cmd.merchant.name, document: cmd.merchant.document });
    const customer = await this.customers.upsert(cmd.merchant.id, cmd.customer);
    const target: Target = { convenio, gateway, ctx, customer, payer: this.customers.toPayer(customer) };

    // Uma requisição faz no máximo uma troca de método e uma resolução de tentativa vencida.
    const done = { switched: false, resolvedExpired: false };
    for (;;) {
      const decision = await this.decide(cmd, target, done);
      switch (decision.kind) {
        case 'REUSE':
          this.logger.log({ msg: 'active attempt reused', transactionId: decision.attempt.id, chargeId: decision.attempt.chargeId, method: cmd.method });
          return { view: await this.presenter.present(decision.attempt, decision.attempt.customer), created: false };
        case 'CREATE':
          return { view: await this.dispatch(cmd, target, decision.attempt, decision.request), created: true };
        case 'RESOLVE_EXPIRED':
          // Tentativa vencida não é liberada às cegas: consulta o banco (pode ter sido paga) e só depois segue.
          done.resolvedExpired = true;
          await this.lifecycle.advance(decision.attempt.id, TransactionEventSource.API);
          break;
        case 'SWITCH':
          done.switched = true;
          await this.switchMethod(decision.attempt, cmd.method);
          break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Decisão (com a Charge bloqueada)
  // ---------------------------------------------------------------------------

  private async decide(cmd: CreatePaymentCommand, target: Target, done: { switched: boolean; resolvedExpired: boolean }): Promise<Decision> {
    const key = { merchantId: cmd.merchant.id, externalReference: cmd.externalReference, amountCents: cmd.amountCents, expiresAt: cmd.chargeExpiresAt };
    try {
      return await this.charges.withLockedChargeByReference(key, async (db, charge): Promise<Decision> => {
        const now = new Date();
        this.assertOpen(charge, cmd, now);

        const active = await db.transaction.findFirst({ where: { chargeId: charge.id, status: { in: [...ACTIVE_STATUSES] } }, include: { customer: true } });
        if (!active) return this.insertAttempt(db, charge, cmd, target);

        const busy = (reason: string, until?: Date | null) =>
          new AttemptInProgressError({ reason, transactionId: active.id, status: active.status, method: active.method, until: until?.toISOString() ?? null });
        if (active.status === S.PROCESSANDO) throw busy('a tentativa ainda está sendo registrada no banco');
        if (active.status === S.EM_VERIFICACAO) throw busy('a tentativa venceu e aguarda a confirmação do banco', active.verificationUntil);
        if (active.cancelRequestedAt && now.getTime() - active.cancelRequestedAt.getTime() < METHOD_SWITCH_LEASE_MS) {
          throw busy('há uma troca de método em andamento');
        }
        if (active.expiresAt && active.expiresAt <= now) {
          if (done.resolvedExpired) throw busy('a tentativa venceu e ainda não pôde ser verificada no banco');
          return { kind: 'RESOLVE_EXPIRED', attempt: active };
        }
        if (active.method === cmd.method) return { kind: 'REUSE', attempt: active };

        // Outra requisição criou uma tentativa enquanto esta fazia a troca: não entra em disputa.
        if (done.switched) throw busy('outra tentativa foi iniciada para esta cobrança');
        await db.transaction.update({ where: { id: active.id }, data: { cancelRequestedAt: now, cancelReason: CANCEL_REASON.METHOD_SWITCH } });
        await db.transactionEvent.create({
          data: { transactionId: active.id, type: 'cancel.requested', source: TransactionEventSource.API, data: { reason: CANCEL_REASON.METHOD_SWITCH, newMethod: cmd.method } },
        });
        return { kind: 'SWITCH', attempt: active };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'idempotency_key') || isUniqueViolation(err, 'idempotencyKey')) throw new IdempotencyKeyReusedError();
      // Última barreira: o índice único parcial recusou uma segunda tentativa ativa.
      if (isUniqueViolation(err)) throw new AttemptInProgressError({ reason: 'outra tentativa foi iniciada para esta cobrança' });
      throw err;
    }
  }

  private assertOpen(charge: Charge, cmd: CreatePaymentCommand, now: Date): void {
    if (charge.amountCents !== cmd.amountCents) {
      throw new ChargeAmountMismatchError({ chargeId: charge.id, chargeAmount: charge.amountCents, requestedAmount: cmd.amountCents });
    }
    if (charge.status === ChargeStatus.PAGA) throw new PaymentAlreadyConfirmedError({ chargeId: charge.id, paidTransactionId: charge.paidTransactionId });
    if (charge.status !== ChargeStatus.ABERTA) throw new ChargeClosedError({ chargeId: charge.id, status: charge.status });
    if (charge.expiresAt && charge.expiresAt <= now) throw new ChargeClosedError({ chargeId: charge.id, status: ChargeStatus.EXPIRADA });
  }

  /** Grava a tentativa ANTES da chamada ao banco, já como a única ativa da Charge. */
  private async insertAttempt(db: Db, charge: Charge, cmd: CreatePaymentCommand, target: Target): Promise<Decision> {
    const id = randomUUID();
    const request = await this.buildChargeRequest(cmd, id, target);
    const attempt = await db.transaction.create({
      data: {
        id,
        chargeId: charge.id,
        merchantId: cmd.merchant.id,
        convenioId: target.convenio.id,
        customerId: target.customer.id,
        method: cmd.method,
        provider: target.convenio.provider,
        status: S.PROCESSANDO,
        amountCents: charge.amountCents,
        description: cmd.description,
        idempotencyKey: cmd.idempotencyKey,
        externalReference: charge.externalReference,
        providerReference: target.gateway.providerReferenceFor(target.ctx, request) ?? null,
        metadata: cmd.metadata as Prisma.InputJsonObject | undefined,
      },
    });
    await db.transactionEvent.create({
      data: { transactionId: id, type: 'payment.created', toStatus: S.PROCESSANDO, source: TransactionEventSource.API, data: { convenioId: target.convenio.id, chargeId: charge.id } },
    });
    return { kind: 'CREATE', attempt, request };
  }

  // ---------------------------------------------------------------------------
  // Troca de método: só libera depois de o banco confirmar o cancelamento
  // ---------------------------------------------------------------------------

  private async switchMethod(active: Transaction, newMethod: PaymentMethod): Promise<void> {
    const log = { transactionId: active.id, chargeId: active.chargeId, from: active.method, to: newMethod };
    const outcome = await this.lifecycle.cancelAtProvider(active.id, TransactionEventSource.API);
    this.logger.log({ msg: 'method switch: cancel outcome', ...log, outcome: outcome.kind });
    // CANCELED, PAID e SKIPPED: a decisão é refeita com a Charge bloqueada (PAID vira PAGAMENTO_JA_CONFIRMADO).
    if (outcome.kind === 'ERROR') throw outcome.error.attachTransaction(active.id);
    if (outcome.kind === 'REFUSED') {
      throw new CancellationRefusedError({
        reason: outcome.reason,
        transactionId: active.id,
        method: active.method,
        activeUntil: outcome.activeUntil?.toISOString() ?? null,
        ...(outcome.limitation ? { limitation: true } : {}),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Envio ao banco (sem lock) e aplicação do resultado (com lock)
  // ---------------------------------------------------------------------------

  private async dispatch(cmd: CreatePaymentCommand, target: Target, attempt: Transaction, request: ChargeRequest): Promise<PaymentView> {
    const log = { transactionId: attempt.id, chargeId: attempt.chargeId, merchantId: cmd.merchant.id, convenioId: target.convenio.id, provider: target.convenio.provider, method: cmd.method };
    this.logger.log({ msg: 'charge dispatching', ...log, amountCents: attempt.amountCents });

    let result: ChargeResult;
    try {
      result = await target.gateway.createCharge(target.ctx, request);
    } catch (err) {
      await this.recordFailure(attempt, err, log);
      if (err instanceof AppError) throw err.attachTransaction(attempt.id);
      throw new UnexpectedProcessingError({ cause: err }).attachTransaction(attempt.id);
    }

    const { transaction, charge, superseded } = await this.applyResult(attempt, result, cmd, request);
    if (superseded.length > 0) await this.lifecycle.releaseSuperseded(superseded, TransactionEventSource.API);
    this.logger.log({ msg: 'charge created', ...log, status: transaction.status, providerReference: transaction.providerReference });

    if (charge.status === ChargeStatus.PAGA && charge.paidTransactionId !== transaction.id) {
      // Um pagamento tardio de outra tentativa quitou a cobrança enquanto esta era criada.
      // A nova tentativa já está marcada para cancelamento; tenta agora e o job insiste se falhar.
      await this.lifecycle.releaseSuperseded([transaction], TransactionEventSource.API);
      throw new PaymentAlreadyConfirmedError({ chargeId: charge.id, paidTransactionId: charge.paidTransactionId }).attachTransaction(transaction.id);
    }
    return this.presenter.present(transaction, target.customer);
  }

  private applyResult(attempt: Transaction, result: ChargeResult, cmd: CreatePaymentCommand, request: ChargeRequest) {
    const providerData = (
      result.providerData.boleto ? { ...result.providerData, boleto: { ...result.providerData.boleto, instructions: cmd.boleto?.instructions ?? [] } } : result.providerData
    ) as Prisma.InputJsonObject;
    const registered = { providerReference: result.providerReference, providerData, expiresAt: expiresAtFor(request, result) ?? null };

    return this.charges.withLockedCharge(attempt.chargeId!, async (db) => {
      const cur = await db.transaction.findUniqueOrThrow({ where: { id: attempt.id } });
      // Se uma consulta ao banco (webhook, job) já avançou a tentativa, o status dela fica: só completamos os dados.
      const stillProcessing = cur.status === S.PROCESSANDO;
      let superseded: Transaction[] = [];

      if (result.status === S.FALHOU) {
        if (stillProcessing) {
          await db.transaction.update({
            where: { id: cur.id },
            data: { ...registered, status: S.FALHOU, failureCode: result.failure?.code ?? 'DECLINED', failureMessage: result.failure?.message ?? null, version: { increment: 1 } },
          });
        }
      } else {
        await db.transaction.update({
          where: { id: cur.id },
          data: { ...registered, ...(stillProcessing ? { status: S.PENDENTE } : {}), lastSyncedAt: new Date(), version: { increment: 1 } },
        });
        if (result.status === S.CONFIRMADA) {
          const settled = await this.settlement.settle(db, cur.id, { ...result.payment, source: TransactionEventSource.API });
          if (settled.kind === 'CONFIRMED') superseded = settled.superseded;
        }
      }
      const transaction = await db.transaction.findUniqueOrThrow({ where: { id: cur.id } });
      await db.transactionEvent.create({
        data: {
          transactionId: cur.id,
          type: result.status === S.FALHOU ? 'charge.failed' : 'charge.registered',
          fromStatus: cur.status,
          toStatus: transaction.status,
          source: TransactionEventSource.API,
          data: { provider: attempt.provider, result: result.status, ...(stillProcessing ? {} : { statusKept: true }) },
        },
      });
      return { transaction, charge: await db.charge.findUniqueOrThrow({ where: { id: attempt.chargeId! } }), superseded };
    });
  }

  /**
   * - Resultado INCERTO (timeout/5xx): fica PROCESSANDO e continua bloqueando a Charge até o job consultar o banco.
   * - Recusa, ou erro antes do envio: FALHOU, e a Charge fica livre para nova tentativa.
   * - Erro desconhecido: tratado como incerto (nunca assumir que o banco não registrou).
   */
  private async recordFailure(attempt: Transaction, err: unknown, log: Record<string, unknown>): Promise<void> {
    const uncertain = !(err instanceof AppError) || (err instanceof BankIntegrationError && err.outcome === 'UNCERTAIN');
    const appErr = err instanceof AppError ? err : undefined;
    const bank = err instanceof BankIntegrationError ? err : undefined;
    if (uncertain) this.logger.error({ msg: 'charge outcome uncertain; left for reconciliation', ...log, err });
    else this.logger.warn({ msg: 'charge failed', ...log, code: appErr?.code, bankErrorCode: bank?.bankErrorCode });

    try {
      await this.charges.withLockedCharge(attempt.chargeId!, async (db) => {
        const cur = await db.transaction.findUniqueOrThrow({ where: { id: attempt.id } });
        const fail = !uncertain && cur.status === S.PROCESSANDO;
        if (fail) {
          await db.transaction.update({
            where: { id: cur.id },
            data: {
              status: S.FALHOU,
              failureCode: (bank?.bankErrorCode ? `${appErr!.code}:${bank.bankErrorCode}` : appErr!.code).slice(0, 64),
              failureMessage: (bank?.bankMessage ?? appErr!.message).slice(0, 500),
              version: { increment: 1 },
            },
          });
        }
        await db.transactionEvent.create({
          data: {
            transactionId: cur.id,
            type: uncertain ? 'charge.uncertain' : 'charge.failed',
            fromStatus: cur.status,
            toStatus: fail ? S.FALHOU : cur.status,
            source: TransactionEventSource.API,
            data: { code: appErr?.code ?? 'UNKNOWN', outcome: bank?.outcome ?? (uncertain ? 'UNCERTAIN' : 'NOT_PROCESSED') },
          },
        });
      });
    } catch (persistErr) {
      // Não mascara o erro original; a tentativa fica PROCESSANDO e o job a resolve.
      this.logger.error({ msg: 'failed to persist charge failure', ...log, err: persistErr });
    }
  }

  // ---------------------------------------------------------------------------

  private validateBusinessRules(cmd: CreatePaymentCommand): void {
    const extras = (['pix', 'boleto', 'card'] as const).filter((k) => cmd[k] !== undefined && k !== methodKey(cmd.method));
    if (extras.length > 0) throw new ValidationError(`Opções incompatíveis com method=${cmd.method}: ${extras.join(', ')}`);
    if (cmd.chargeExpiresAt && cmd.chargeExpiresAt <= new Date()) throw new ValidationError('chargeExpiresAt deve estar no futuro');

    if (cmd.method === PaymentMethod.BOLETO) {
      if (!cmd.boleto) throw new ValidationError('boleto é obrigatório quando method=BOLETO');
      if (!cmd.customer.address) throw new ValidationError('customer.address é obrigatório para boleto');
      const days = diffInDays(parseIsoDate(todayBr()), parseDueDate(cmd.boleto.dueDate));
      if (days < 0) throw new ValidationError('boleto.dueDate não pode estar no passado');
      if (days > MAX_BOLETO_DAYS_AHEAD) throw new ValidationError('boleto.dueDate muito distante');
    }
    if (cmd.method === PaymentMethod.CREDIT_CARD && !cmd.card) throw new ValidationError('card é obrigatório quando method=CREDIT_CARD');
  }

  private async buildChargeRequest(cmd: CreatePaymentCommand, transactionId: string, target: Target): Promise<ChargeRequest> {
    const base = { transactionId, amountCents: cmd.amountCents, description: cmd.description, payer: target.payer };
    switch (cmd.method) {
      case PaymentMethod.PIX:
        return {
          ...base,
          method: PaymentMethod.PIX,
          txid: transactionId.replace(/-/g, ''), // 32 alfanuméricos: dentro da regra [a-zA-Z0-9]{26,35}
          expiresInSeconds: cmd.pix?.expiresInSeconds ?? DEFAULT_PIX_EXPIRATION,
        };
      case PaymentMethod.BOLETO: {
        const boleto = cmd.boleto!;
        return {
          ...base,
          method: PaymentMethod.BOLETO,
          sequence: await this.convenios.nextNossoNumeroSequence(target.convenio.id),
          dueDate: parseIsoDate(boleto.dueDate),
          issueDate: parseIsoDate(todayBr()),
          instructions: boleto.instructions,
          finePercent: boleto.finePercent,
          interestMonthlyPercent: boleto.interestMonthlyPercent,
          acceptUntilDaysAfterDue: boleto.acceptUntilDaysAfterDue,
        };
      }
      case PaymentMethod.CREDIT_CARD: {
        const card = cmd.card!;
        // DIRECT fica de fora de propósito: nenhum adapter o oferece (ver CardMode no contrato).
        if (card.mode !== 'HOSTED_LINK') throw new UnsupportedPaymentMethodError(target.convenio.provider, `CREDIT_CARD/${card.mode}`);
        return {
          ...base,
          method: PaymentMethod.CREDIT_CARD,
          mode: 'HOSTED_LINK',
          linkTtlSeconds: this.config.get('CARD_LINK_TTL_SECONDS'),
          maxInstallments: card.maxInstallments,
          softDescriptor: card.softDescriptor,
        };
      }
    }
  }
}

/**
 * Até quando a tentativa é considerada ativa.
 * Pix e link de cartão: a validade informada pelo banco. Boleto: fim do último dia em que pode ser pago.
 */
function expiresAtFor(request: ChargeRequest, result: ChargeResult): Date | undefined {
  if (request.method !== PaymentMethod.BOLETO) return result.expiresAt;
  const lastPayableDay = new Date(request.dueDate.getTime() + (request.acceptUntilDaysAfterDue ?? 0) * 86_400_000);
  return endOfCivilDayBr(lastPayableDay);
}

/** O DTO garante o formato YYYY-MM-DD; aqui barramos datas que não existem no calendário (ex.: 30/02). */
function parseDueDate(value: string): Date {
  try {
    return parseIsoDate(value);
  } catch {
    throw new ValidationError('boleto.dueDate não é uma data válida');
  }
}

function methodKey(method: PaymentMethod): 'pix' | 'boleto' | 'card' {
  return method === PaymentMethod.PIX ? 'pix' : method === PaymentMethod.BOLETO ? 'boleto' : 'card';
}
