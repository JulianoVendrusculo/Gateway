import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ChargeStatus, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../infra/database/prisma.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { AttemptLifecycleService } from '../application/attempt-lifecycle.service';
import { ChargeRepository } from '../application/charge.repository';
import { CANCEL_REASON } from '../application/payment-settlement.service';
import { ACTIVE_STATUSES } from '../domain/transaction-state-machine';

const S = TransactionStatus;
/** Tentativa PROCESSANDO há mais tempo que isto bloqueia a cobrança e precisa de atenção. */
const STUCK_PROCESSING_ALERT_MS = 60 * 60_000;

export interface ReconciliationStats {
  checked: number;
  changed: number;
  failed: number;
  chargesExpired: number;
}

/**
 * Job periódico da v2. Para cada tentativa ativa consulta o banco e aplica o resultado:
 *  - vencidas: nunca são liberadas direto. Consulta o banco; se pagou, confirma; senão a tentativa fica
 *    EM_VERIFICACAO pela janela de tolerância do método e só depois vira EXPIRADA;
 *  - EM_VERIFICACAO: reconsulta a cada ciclo e encerra ao fim da janela;
 *  - PROCESSANDO (criação de resultado incerto): descobre se o banco registrou;
 *  - cancelamentos pendentes de tentativas que perderam para um pagamento: repete até o banco confirmar;
 *  - demais tentativas abertas: reconciliação de rotina (cobre webhook perdido).
 * Também encerra cobranças cujo prazo passou e que não têm tentativa ativa.
 * Seguro com N instâncias: cada transação é reivindicada antes da consulta e toda escrita bloqueia a Charge.
 */
@Injectable()
export class ReconciliationJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationJob.name);
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly scheduler: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly lifecycle: AttemptLifecycleService,
    private readonly charges: ChargeRepository,
    private readonly idempotency: IdempotencyService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('RECONCILIATION_ENABLED')) return;
    const handle = setInterval(() => void this.run(), this.config.get('RECONCILIATION_INTERVAL_MS'));
    handle.unref();
    this.scheduler.addInterval('reconciliation', handle);
  }

  async run(): Promise<ReconciliationStats> {
    const stats: ReconciliationStats = { checked: 0, changed: 0, failed: 0, chargesExpired: 0 };
    if (this.running) return stats;
    this.running = true;
    try {
      await this.advanceAttempts(stats);
      stats.chargesExpired = await this.expireCharges();
      const purged = await this.idempotency.purgeExpired();
      await this.warnExpiringCertificates();
      if (stats.checked > 0 || stats.chargesExpired > 0 || purged > 0) this.logger.log({ msg: 'reconciliation cycle', ...stats, idempotencyPurged: purged });
    } catch (err) {
      this.logger.error({ msg: 'reconciliation cycle failed', err });
    } finally {
      this.running = false;
    }
    return stats;
  }

  private async advanceAttempts(stats: ReconciliationStats): Promise<void> {
    const now = new Date();
    const resyncBefore = new Date(now.getTime() - this.config.get('RECONCILIATION_MIN_RESYNC_SECONDS') * 1000);
    const candidates = await this.prisma.transaction.findMany({
      where: {
        chargeId: { not: null },
        status: { in: [...ACTIVE_STATUSES] },
        providerReference: { not: null },
        OR: [
          { lastSyncedAt: null },
          { lastSyncedAt: { lt: resyncBefore } },
          // Vencimento e fim da janela de verificação não esperam o intervalo de reconsulta.
          { status: S.PENDENTE, expiresAt: { lte: now } },
          { status: S.EM_VERIFICACAO, verificationUntil: { lte: now } },
        ],
      },
      // Quem falhou vai para o fim (a tentativa é registrada em lastSyncedAt), então não trava a fila.
      orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
      take: this.config.get('RECONCILIATION_BATCH_SIZE'),
      select: { id: true, status: true, createdAt: true, cancelReason: true, cancelRequestedAt: true },
    });

    for (const candidate of candidates) {
      stats.checked++;
      try {
        const cancelPending = candidate.cancelRequestedAt !== null && candidate.cancelReason === CANCEL_REASON.CHARGE_PAID && candidate.status !== S.PROCESSANDO;
        if (cancelPending) {
          const outcome = await this.lifecycle.cancelAtProvider(candidate.id, TransactionEventSource.RECONCILIATION);
          if (outcome.kind === 'CANCELED' || outcome.kind === 'PAID') stats.changed++;
          if (outcome.kind === 'ERROR') stats.failed++;
        } else if ((await this.lifecycle.advance(candidate.id, TransactionEventSource.RECONCILIATION)).changed) {
          stats.changed++;
        }
      } catch (err) {
        stats.failed++;
        const stuck = candidate.status === S.PROCESSANDO && now.getTime() - candidate.createdAt.getTime() > STUCK_PROCESSING_ALERT_MS;
        if (stuck) {
          // A cobrança desta inscrição está bloqueada por uma tentativa que o banco não confirma nem nega.
          this.logger.error({ msg: 'attempt stuck in PROCESSANDO is blocking its charge', alert: 'TENTATIVA_PRESA', transactionId: candidate.id, err });
        } else {
          this.logger.warn({ msg: 'reconciliation item failed', transactionId: candidate.id, err });
        }
        await this.prisma.transaction.updateMany({ where: { id: candidate.id }, data: { lastSyncedAt: new Date() } });
      }
    }
  }

  /** Cobrança com prazo vencido só é encerrada quando não há mais tentativa que possa ser paga. */
  private async expireCharges(): Promise<number> {
    const overdue = await this.prisma.charge.findMany({
      where: { status: ChargeStatus.ABERTA, expiresAt: { lte: new Date() }, transactions: { none: { status: { in: [...ACTIVE_STATUSES] } } } },
      select: { id: true },
      take: this.config.get('RECONCILIATION_BATCH_SIZE'),
    });
    let expired = 0;
    for (const { id } of overdue) {
      const closed = await this.charges.withLockedCharge(id, async (db, charge) => {
        if (charge.status !== ChargeStatus.ABERTA || !charge.expiresAt || charge.expiresAt > new Date()) return false;
        if ((await db.transaction.count({ where: { chargeId: id, status: { in: [...ACTIVE_STATUSES] } } })) > 0) return false;
        await db.charge.update({ where: { id }, data: { status: ChargeStatus.EXPIRADA } });
        return true;
      });
      if (closed) {
        expired++;
        this.logger.log({ msg: 'charge expired', chargeId: id });
      }
    }
    return expired;
  }

  private async warnExpiringCertificates(): Promise<void> {
    const soon = await this.prisma.convenio.findMany({
      where: { isActive: true, certificateExpiresAt: { lt: new Date(Date.now() + 30 * 86_400_000) } },
      select: { id: true, merchantId: true, certificateExpiresAt: true },
    });
    for (const c of soon) {
      this.logger.warn({ msg: 'convenio certificate expiring', convenioId: c.id, merchantId: c.merchantId, expiresAt: c.certificateExpiresAt });
    }
  }
}
