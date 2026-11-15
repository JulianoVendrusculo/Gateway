import { Injectable, Logger } from '@nestjs/common';
import { ChargeStatus, Refund, Transaction, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { ProviderPayment } from '../domain/payment-gateway.port';
import { ACTIVE_STATUSES, assertTransition } from '../domain/transaction-state-machine';
import { Db } from './charge.repository';

export interface PaymentEvidence extends ProviderPayment {
  source: TransactionEventSource;
  providerStatus?: string;
}

export type SettlementResult =
  /** Primeira confirmação: a transação quitou a Charge. `superseded` são as outras tentativas ativas, a cancelar no banco. */
  | { kind: 'CONFIRMED'; transaction: Transaction; superseded: Transaction[] }
  /** A Charge já estava paga: pagamento registrado como PAGO_DUPLICADO, com pendência de estorno. */
  | { kind: 'DUPLICATE'; transaction: Transaction; refund: Refund }
  /** Reentrega de um pagamento já registrado: nada muda. */
  | { kind: 'ALREADY_SETTLED'; transaction: Transaction };

export const CANCEL_REASON = { METHOD_SWITCH: 'TROCA_DE_METODO', CHARGE_PAID: 'COBRANCA_PAGA' } as const;

const REFUND_REASON = { CHARGE_ALREADY_PAID: 'COBRANCA_JA_PAGA', SECOND_PAYMENT: 'SEGUNDO_PAGAMENTO_DA_TENTATIVA' } as const;

/**
 * Único ponto do sistema que registra um pagamento confirmado. Regras:
 *  - a primeira confirmação vence: a transação vira CONFIRMADA e a Charge, PAGA;
 *  - as outras tentativas ativas ficam marcadas para cancelamento no banco;
 *  - pagamento de uma Charge já paga nunca se perde: vira PAGO_DUPLICADO e abre um Refund
 *    PENDENTE_ANALISE. Nenhum estorno é executado aqui.
 *
 * `settle` só pode ser chamado dentro de ChargeRepository.withLockedCharge.
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);

  async settle(db: Db, transactionId: string, evidence: PaymentEvidence): Promise<SettlementResult> {
    const tx = await db.transaction.findUniqueOrThrow({ where: { id: transactionId } });
    if (!tx.chargeId) throw new Error(`transação ${tx.id} não pertence a uma Charge`);
    const charge = await db.charge.findUniqueOrThrow({ where: { id: tx.chargeId } });

    // Mesmo pagamento informado de novo (webhook reentregue, job e webhook juntos): nada a fazer.
    if (evidence.id) {
      const known = await db.transaction.findFirst({ where: { convenioId: tx.convenioId, providerPaymentId: evidence.id } });
      if (known) return { kind: 'ALREADY_SETTLED', transaction: known };
    }

    if (tx.status === TransactionStatus.CONFIRMADA || tx.status === TransactionStatus.PAGO_DUPLICADO) {
      // Sem identificador do pagamento não há como saber se é outro pagamento: tratado como repetição.
      if (!evidence.id) return { kind: 'ALREADY_SETTLED', transaction: tx };
      if (!tx.providerPaymentId) {
        const adopted = await db.transaction.update({ where: { id: tx.id }, data: { providerPaymentId: evidence.id } });
        return { kind: 'ALREADY_SETTLED', transaction: adopted };
      }
      // A mesma tentativa (mesmo boleto, mesmo link) recebeu um segundo pagamento.
      return this.recordSecondPayment(db, tx, evidence);
    }

    const paidAt = evidence.paidAt ?? new Date();
    const paidAmountCents = evidence.amountCents ?? tx.amountCents;
    const settled = { paidAt, paidAmountCents, providerPaymentId: evidence.id ?? null, verificationUntil: null, cancelRequestedAt: null, cancelReason: null, lastSyncedAt: new Date() };

    if (charge.status === ChargeStatus.PAGA) {
      assertTransition(tx.status, TransactionStatus.PAGO_DUPLICADO);
      const duplicate = await db.transaction.update({ where: { id: tx.id }, data: { ...settled, status: TransactionStatus.PAGO_DUPLICADO, version: { increment: 1 } } });
      await this.event(db, tx.id, 'payment.duplicate', tx.status, TransactionStatus.PAGO_DUPLICADO, evidence, { paidTransactionId: charge.paidTransactionId });
      const refund = await this.openRefund(db, duplicate, REFUND_REASON.CHARGE_ALREADY_PAID);
      return { kind: 'DUPLICATE', transaction: duplicate, refund };
    }

    if (paidAmountCents !== charge.amountCents) {
      this.logger.warn({ msg: 'paid amount differs from charge amount', chargeId: charge.id, transactionId: tx.id, amountCents: charge.amountCents, paidAmountCents });
    }
    if (charge.status !== ChargeStatus.ABERTA) {
      // Cobrança cancelada ou expirada que recebeu pagamento: o dinheiro entrou, então ela fica paga.
      this.logger.warn({ msg: 'payment confirmed for a closed charge', chargeId: charge.id, transactionId: tx.id, previousStatus: charge.status });
    }

    assertTransition(tx.status, TransactionStatus.CONFIRMADA);
    const confirmed = await db.transaction.update({ where: { id: tx.id }, data: { ...settled, status: TransactionStatus.CONFIRMADA, version: { increment: 1 } } });
    await db.charge.update({ where: { id: charge.id }, data: { status: ChargeStatus.PAGA, paidTransactionId: tx.id, paidAt } });
    await this.event(db, tx.id, 'payment.confirmed', tx.status, TransactionStatus.CONFIRMADA, evidence, { paidAmountCents });

    // A Charge está paga: qualquer outra tentativa que ainda possa ser paga precisa ser cancelada no banco.
    const superseded = await db.transaction.findMany({ where: { chargeId: charge.id, id: { not: tx.id }, status: { in: [...ACTIVE_STATUSES] } } });
    for (const other of superseded) {
      await db.transaction.update({ where: { id: other.id }, data: { cancelRequestedAt: new Date(), cancelReason: CANCEL_REASON.CHARGE_PAID, cancelAttempts: 0 } });
      await db.transactionEvent.create({ data: { transactionId: other.id, type: 'cancel.requested', source: evidence.source, data: { reason: CANCEL_REASON.CHARGE_PAID, paidTransactionId: tx.id } } });
    }
    this.logger.log({ msg: 'charge paid', chargeId: charge.id, transactionId: tx.id, method: tx.method, source: evidence.source, superseded: superseded.length });
    return { kind: 'CONFIRMED', transaction: confirmed, superseded };
  }

  /** Segundo pagamento da MESMA tentativa: fica em uma linha própria, ligada à original. */
  private async recordSecondPayment(db: Db, original: Transaction, evidence: PaymentEvidence): Promise<SettlementResult> {
    const duplicate = await db.transaction.create({
      data: {
        id: randomUUID(),
        chargeId: original.chargeId,
        merchantId: original.merchantId,
        convenioId: original.convenioId,
        customerId: original.customerId,
        method: original.method,
        provider: original.provider,
        status: TransactionStatus.PAGO_DUPLICADO,
        amountCents: original.amountCents,
        paidAmountCents: evidence.amountCents ?? original.amountCents,
        paidAt: evidence.paidAt ?? new Date(),
        description: original.description,
        externalReference: original.externalReference,
        idempotencyKey: `dup:${createHash('sha256').update(`${original.id}:${evidence.id}`).digest('hex').slice(0, 48)}`,
        providerPaymentId: evidence.id,
        duplicateOfId: original.id,
      },
    });
    await this.event(db, duplicate.id, 'payment.duplicate', null, TransactionStatus.PAGO_DUPLICADO, evidence, { duplicateOf: original.id });
    const refund = await this.openRefund(db, duplicate, REFUND_REASON.SECOND_PAYMENT);
    return { kind: 'DUPLICATE', transaction: duplicate, refund };
  }

  private async openRefund(db: Db, duplicate: Transaction, reason: string): Promise<Refund> {
    const refund = await db.refund.create({
      data: { chargeId: duplicate.chargeId!, transactionId: duplicate.id, amountCents: duplicate.paidAmountCents ?? duplicate.amountCents, reason },
    });
    // Alerta: há dinheiro recebido em duplicidade aguardando análise humana.
    this.logger.error({
      msg: 'duplicate payment received; refund pending analysis',
      alert: 'PAGO_DUPLICADO',
      chargeId: duplicate.chargeId,
      transactionId: duplicate.id,
      refundId: refund.id,
      method: duplicate.method,
      amountCents: refund.amountCents,
      reason,
    });
    return refund;
  }

  private event(db: Db, transactionId: string, type: string, from: TransactionStatus | null, to: TransactionStatus, evidence: PaymentEvidence, data: Record<string, unknown>) {
    return db.transactionEvent.create({
      data: { transactionId, type, fromStatus: from, toStatus: to, source: evidence.source, data: { providerStatus: evidence.providerStatus ?? null, ...data } },
    });
  }
}
