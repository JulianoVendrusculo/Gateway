import { Injectable, Logger } from '@nestjs/common';
import { IdempotencyKey, IdempotencyStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  AppError,
  IdempotencyInProgressError,
  IdempotencyKeyInvalidError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
} from '../../common/errors';
import { mapError } from '../../common/errors/error-response';
import { AppConfig } from '../../config/app-config';
import { PrismaService, isUniqueViolation } from '../../infra/database/prisma.service';

const KEY_FORMAT = /^[A-Za-z0-9_\-:.]{8,128}$/;

export interface IdempotentRequest {
  merchantId: string;
  key: string | undefined;
  /** Ex.: "POST /v1/payments" — a mesma chave não pode ser usada em outro endpoint. */
  scope: string;
  payload: unknown;
  requestId?: string;
}

export interface HandlerResult {
  statusCode: number;
  body: unknown;
  transactionId?: string;
}

export interface IdempotentResponse {
  statusCode: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Idempotency-Key (padrão IETF draft-ietf-httpapi-idempotency-key-header):
 *  1. Reserva a chave com INSERT (UNIQUE merchant+key) — concorrência resolvida pelo banco.
 *  2. Mesmo payload + concluída  → devolve a resposta gravada (replay).
 *  3. Payload diferente          → 422 IDEMPOTENCY_KEY_REUSED.
 *  4. Em andamento               → 409 (cliente deve aguardar e repetir).
 *  5. Erro ANTES de efeitos colaterais libera a chave; erro DEPOIS (transação criada) é gravado.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async execute(req: IdempotentRequest, handler: () => Promise<HandlerResult>): Promise<IdempotentResponse> {
    if (!req.key) throw new IdempotencyKeyRequiredError();
    if (!KEY_FORMAT.test(req.key)) throw new IdempotencyKeyInvalidError();
    const requestHash = createHash('sha256').update(`${req.scope}\n${canonicalJson(req.payload)}`).digest('hex');

    const reservation = await this.reserve(req.merchantId, req.key, req.scope, requestHash);
    if ('replay' in reservation) return reservation.replay;

    try {
      const result = await handler();
      await this.complete(reservation.record.id, result.statusCode, result.body, result.transactionId);
      return { statusCode: result.statusCode, body: result.body, replayed: false };
    } catch (err) {
      if (err instanceof AppError && err.hasPersistedSideEffects) {
        const mapped = mapError(err, req.requestId);
        await this.complete(reservation.record.id, mapped.status, mapped.body, err.transactionId).catch((e: unknown) =>
          this.logger.error({ msg: 'failed to persist idempotent error response', err: e }),
        );
      } else {
        await this.prisma.idempotencyKey.delete({ where: { id: reservation.record.id } }).catch(() => undefined);
      }
      throw err;
    }
  }

  async purgeExpired(limit = 1000): Promise<number> {
    const expired = await this.prisma.idempotencyKey.findMany({ where: { expiresAt: { lt: new Date() } }, select: { id: true }, take: limit });
    if (expired.length === 0) return 0;
    const { count } = await this.prisma.idempotencyKey.deleteMany({ where: { id: { in: expired.map((e) => e.id) } } });
    return count;
  }

  private async reserve(
    merchantId: string,
    key: string,
    scope: string,
    requestHash: string,
  ): Promise<{ record: IdempotencyKey } | { replay: IdempotentResponse }> {
    const now = Date.now();
    const lockedUntil = new Date(now + this.config.get('IDEMPOTENCY_LOCK_TIMEOUT_SECONDS') * 1000);
    const expiresAt = new Date(now + this.config.get('IDEMPOTENCY_TTL_HOURS') * 3_600_000);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const record = await this.prisma.idempotencyKey.create({
          data: { merchantId, key, scope, requestHash, status: IdempotencyStatus.IN_PROGRESS, lockedUntil, expiresAt },
        });
        return { record };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }

      const existing = await this.prisma.idempotencyKey.findUnique({ where: { merchantId_key: { merchantId, key } } });
      if (!existing) continue; // removida entre o INSERT e o SELECT: tenta reservar de novo
      if (existing.expiresAt.getTime() < now) {
        await this.prisma.idempotencyKey.deleteMany({ where: { id: existing.id, expiresAt: { lt: new Date(now) } } });
        continue;
      }
      if (existing.requestHash !== requestHash || existing.scope !== scope) throw new IdempotencyKeyReusedError();
      if (existing.status === IdempotencyStatus.COMPLETED) {
        return { replay: { statusCode: existing.responseStatus!, body: existing.responseBody, replayed: true } };
      }
      // IN_PROGRESS: se o lock expirou (processo caiu), assume a reserva de forma atômica.
      if (existing.lockedUntil.getTime() < now) {
        const { count } = await this.prisma.idempotencyKey.updateMany({
          where: { id: existing.id, status: IdempotencyStatus.IN_PROGRESS, lockedUntil: existing.lockedUntil },
          data: { lockedUntil },
        });
        if (count === 1) {
          this.logger.warn({ msg: 'idempotency stale lock taken over', merchantId, idempotencyRecordId: existing.id });
          return { record: { ...existing, lockedUntil } };
        }
      }
      throw new IdempotencyInProgressError();
    }
    throw new IdempotencyInProgressError();
  }

  private async complete(id: string, statusCode: number, body: unknown, transactionId?: string): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseStatus: statusCode,
        responseBody: (body ?? null) as Prisma.InputJsonValue,
        transactionId: transactionId ?? null,
      },
    });
  }
}

/** JSON canônico (chaves ordenadas) para que {a,b} e {b,a} gerem o mesmo hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
