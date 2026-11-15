import { Injectable } from '@nestjs/common';
import { Charge, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infra/database/prisma.service';

export type Db = Prisma.TransactionClient;

/** As transações com lock só tomam decisões e gravam: não há chamada ao banco dentro delas. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export interface ChargeKey {
  merchantId: string;
  externalReference: string;
  amountCents: number;
  expiresAt?: Date;
}

/**
 * Toda decisão sobre uma Charge (criar tentativa, confirmar pagamento, cancelar, expirar) roda
 * dentro de uma transação que bloqueia a linha da Charge com SELECT ... FOR UPDATE.
 * Duas requisições, dois webhooks ou um webhook e o job nunca decidem ao mesmo tempo.
 *
 * O lock NÃO fica aberto durante chamadas ao banco. Se ficasse, um timeout ou a queda do processo
 * faria o rollback apagar o registro de uma cobrança que o banco já criou. Em vez disso a tentativa
 * é gravada como PROCESSANDO antes da chamada (o que já a torna a única ativa), o banco é chamado
 * sem lock e um novo lock aplica o resultado.
 */
@Injectable()
export class ChargeRepository {
  constructor(private readonly prisma: PrismaService) {}

  withLockedCharge<T>(chargeId: string, work: (db: Db, charge: Charge) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT 1 FROM "charges" WHERE "id" = ${chargeId}::uuid FOR UPDATE`;
      return work(db, await db.charge.findUniqueOrThrow({ where: { id: chargeId } }));
    }, TX_OPTIONS);
  }

  /**
   * Cria a Charge se ela ainda não existir e a devolve bloqueada.
   * Com duas criações simultâneas, o ON CONFLICT faz a segunda esperar a primeira e seguir com a mesma linha.
   */
  withLockedChargeByReference<T>(key: ChargeKey, work: (db: Db, charge: Charge) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (db) => {
      await db.$executeRaw`
        INSERT INTO "charges" ("id", "merchant_id", "external_reference", "amount_cents", "expires_at", "updated_at")
        VALUES (${randomUUID()}::uuid, ${key.merchantId}::uuid, ${key.externalReference}, ${key.amountCents}, ${key.expiresAt ?? null}, now())
        ON CONFLICT ("merchant_id", "external_reference") DO NOTHING`;
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "charges"
        WHERE "merchant_id" = ${key.merchantId}::uuid AND "external_reference" = ${key.externalReference}
        FOR UPDATE`;
      return work(db, await db.charge.findUniqueOrThrow({ where: { id: rows[0].id } }));
    }, TX_OPTIONS);
  }

  findByReference(merchantId: string, externalReference: string) {
    // Sempre filtrado pelo lojista autenticado (previne IDOR).
    return this.prisma.charge.findUnique({
      where: { merchantId_externalReference: { merchantId, externalReference } },
      include: { transactions: { include: { customer: true }, orderBy: { createdAt: 'asc' } }, refunds: true },
    });
  }
}
