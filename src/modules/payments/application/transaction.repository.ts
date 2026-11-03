import { Injectable } from '@nestjs/common';
import { Prisma, Transaction, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { ConcurrentModificationError } from '../../../common/errors';
import { PrismaService } from '../../../infra/database/prisma.service';
import { assertTransition } from '../domain/transaction-state-machine';

export interface TransitionEvent {
  type: string;
  source: TransactionEventSource;
  data?: Prisma.InputJsonValue;
}

@Injectable()
export class TransactionRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.TransactionUncheckedCreateInput, event: TransitionEvent): Promise<Transaction> {
    return this.prisma.$transaction(async (db) => {
      const tx = await db.transaction.create({ data });
      await db.transactionEvent.create({
        data: { transactionId: tx.id, type: event.type, toStatus: tx.status, source: event.source, data: event.data },
      });
      return tx;
    });
  }

  /**
   * Transição com controle otimista: o UPDATE só acontece se o status ainda for `from`
   * (evita que webhook e reconciliação concorrentes sobrescrevam um ao outro).
   */
  transition(
    id: string,
    from: TransactionStatus,
    to: TransactionStatus,
    patch: Omit<Prisma.TransactionUncheckedUpdateManyInput, 'status' | 'version'>,
    event: TransitionEvent,
  ): Promise<Transaction> {
    if (from !== to) assertTransition(from, to);
    return this.prisma.$transaction(async (db) => {
      const { count } = await db.transaction.updateMany({
        where: { id, status: from },
        data: { ...patch, status: to, version: { increment: 1 } },
      });
      if (count === 0) throw new ConcurrentModificationError('Transação');
      await db.transactionEvent.create({
        data: { transactionId: id, type: event.type, fromStatus: from, toStatus: to, source: event.source, data: event.data },
      });
      return db.transaction.findUniqueOrThrow({ where: { id } });
    });
  }

  recordEvent(transactionId: string, event: TransitionEvent): Promise<unknown> {
    return this.prisma.transactionEvent.create({ data: { transactionId, type: event.type, source: event.source, data: event.data } });
  }

  findForMerchant(id: string, merchantId: string) {
    // Sempre filtrado pelo lojista autenticado (previne IDOR).
    return this.prisma.transaction.findFirst({ where: { id, merchantId }, include: { customer: true } });
  }

  findByIdempotencyKey(merchantId: string, idempotencyKey: string) {
    return this.prisma.transaction.findUnique({
      where: { merchantId_idempotencyKey: { merchantId, idempotencyKey } },
      include: { customer: true },
    });
  }
}
