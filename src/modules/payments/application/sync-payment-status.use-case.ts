import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Transaction, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { BankRejectedError, ConcurrentModificationError, ResourceNotFoundError } from '../../../common/errors';
import { PrismaService } from '../../../infra/database/prisma.service';
import { ChargeStatusResult } from '../domain/payment-gateway.port';
import { canTransition } from '../domain/transaction-state-machine';
import { PaymentGatewayRegistry } from '../gateways/payment-gateway.registry';
import { GatewayContextFactory } from './gateway-context.factory';
import { TransactionRepository } from './transaction.repository';

/** Status que ainda podem mudar por informação do provedor. */
const SYNCABLE: ReadonlySet<TransactionStatus> = new Set([
  TransactionStatus.PROCESSING,
  TransactionStatus.PENDING,
  TransactionStatus.AUTHORIZED,
  TransactionStatus.EXPIRED,
  TransactionStatus.CANCELED,
]);

const SYNC_LOCK_MS = 60_000;
/** Cobrança "PROCESSING" que o banco desconhece após este prazo = nunca foi registrada. */
const NOT_FOUND_GRACE_MS = 15 * 60_000;

export interface SyncOutcome {
  transaction: Transaction;
  changed: boolean;
  providerStatus?: string;
}

/**
 * Consulta AUTORITATIVA no provedor e aplica a transição de status.
 * Webhooks nunca alteram status diretamente: são apenas um gatilho para esta consulta.
 */
@Injectable()
export class SyncPaymentStatusUseCase {
  private readonly logger = new Logger(SyncPaymentStatusUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly contextFactory: GatewayContextFactory,
    private readonly transactions: TransactionRepository,
  ) {}

  async execute(transactionId: string, source: TransactionEventSource): Promise<SyncOutcome> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId }, include: { convenio: true, merchant: true } });
    if (!tx) throw new ResourceNotFoundError('Transação');
    if (!SYNCABLE.has(tx.status) || !tx.providerReference) return { transaction: tx, changed: false };
    if (!(await this.claim(tx))) return { transaction: tx, changed: false };

    try {
      const gateway = this.registry.get(tx.provider);
      const ctx = this.contextFactory.build(tx.convenio, { name: tx.merchant.name, document: tx.merchant.document });
      let result: ChargeStatusResult;
      try {
        result = await gateway.getChargeStatus(ctx, {
          transactionId: tx.id,
          method: tx.method,
          providerReference: tx.providerReference,
          amountCents: tx.amountCents,
          createdAt: tx.createdAt,
          expiresAt: tx.expiresAt,
        });
      } catch (err) {
        if (this.neverRegistered(tx, err)) return { transaction: await this.failNeverRegistered(tx, source), changed: true };
        throw err;
      }
      return await this.apply(tx, result, source);
    } finally {
      await this.prisma.transaction.updateMany({ where: { id: tx.id }, data: { syncLockedUntil: null } });
    }
  }

  private async apply(tx: Transaction, result: ChargeStatusResult, source: TransactionEventSource): Promise<SyncOutcome> {
    const now = new Date();
    if (result.status === tx.status) {
      const touched = await this.prisma.transaction.update({ where: { id: tx.id }, data: { lastSyncedAt: now } });
      return { transaction: touched, changed: false, providerStatus: result.providerStatus };
    }
    if (!canTransition(tx.status, result.status)) {
      this.logger.warn({ msg: 'provider status ignored (invalid transition)', transactionId: tx.id, from: tx.status, to: result.status, providerStatus: result.providerStatus });
      await this.transactions.recordEvent(tx.id, { type: 'sync.ignored', source, data: { from: tx.status, to: result.status, providerStatus: result.providerStatus } });
      const touched = await this.prisma.transaction.update({ where: { id: tx.id }, data: { lastSyncedAt: now } });
      return { transaction: touched, changed: false, providerStatus: result.providerStatus };
    }

    // Transação reconciliada após resultado incerto ainda não tem os dados da cobrança: completa agora.
    const fill =
      !tx.providerData && result.providerData
        ? { providerData: result.providerData as Prisma.InputJsonObject, ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}) }
        : {};
    const isPaid = result.status === TransactionStatus.PAID;
    const paidAmount = isPaid ? (result.paidAmountCents ?? tx.amountCents) : undefined;
    if (isPaid && paidAmount !== tx.amountCents) {
      this.logger.warn({ msg: 'paid amount differs from charged amount', transactionId: tx.id, amountCents: tx.amountCents, paidAmountCents: paidAmount });
    }
    try {
      const updated = await this.transactions.transition(
        tx.id,
        tx.status,
        result.status,
        { lastSyncedAt: now, ...fill, ...(isPaid ? { paidAt: result.paidAt ?? now, paidAmountCents: paidAmount } : {}) },
        { type: 'status.synced', source, data: { providerStatus: result.providerStatus, paidAmountCents: paidAmount ?? null } },
      );
      this.logger.log({ msg: 'transaction status changed', transactionId: tx.id, from: tx.status, to: result.status, source });
      return { transaction: updated, changed: true, providerStatus: result.providerStatus };
    } catch (err) {
      if (err instanceof ConcurrentModificationError) {
        // Outro processo (webhook x reconciliação) aplicou antes — estado atual prevalece.
        return { transaction: await this.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } }), changed: false };
      }
      throw err;
    }
  }

  private neverRegistered(tx: Transaction, err: unknown): boolean {
    return (
      tx.status === TransactionStatus.PROCESSING &&
      err instanceof BankRejectedError &&
      err.bankHttpStatus === 404 &&
      Date.now() - tx.createdAt.getTime() > NOT_FOUND_GRACE_MS
    );
  }

  private failNeverRegistered(tx: Transaction, source: TransactionEventSource): Promise<Transaction> {
    this.logger.warn({ msg: 'uncertain charge not found at provider; marking FAILED', transactionId: tx.id });
    return this.transactions.transition(
      tx.id,
      TransactionStatus.PROCESSING,
      TransactionStatus.FAILED,
      { failureCode: 'NOT_REGISTERED_AT_PROVIDER', failureMessage: 'A cobrança não foi registrada no provedor', lastSyncedAt: new Date() },
      { type: 'status.synced', source, data: { reason: 'not_found_at_provider' } },
    );
  }

  /** Claim otimista por linha: evita que várias instâncias consultem o banco para a mesma transação. */
  private async claim(tx: Transaction): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.transaction.updateMany({
      where: { id: tx.id, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: now } }] },
      data: { syncLockedUntil: new Date(now.getTime() + SYNC_LOCK_MS) },
    });
    return count === 1;
  }
}
