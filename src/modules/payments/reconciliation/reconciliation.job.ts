import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TransactionEventSource } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../infra/database/prisma.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { SyncPaymentStatusUseCase } from '../application/sync-payment-status.use-case';
import { OPEN_STATUSES } from '../domain/transaction-state-machine';

const LOOKBACK_DAYS = 45;

/**
 * Reconciliação ativa: consulta periodicamente no banco as cobranças em aberto.
 * Cobre webhooks perdidos, timeouts (PROCESSING) e expiração de Pix.
 * Seguro com N instâncias: cada transação é "reivindicada" via syncLockedUntil.
 */
@Injectable()
export class ReconciliationJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationJob.name);
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly scheduler: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly sync: SyncPaymentStatusUseCase,
    private readonly idempotency: IdempotencyService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('RECONCILIATION_ENABLED')) return;
    const handle = setInterval(() => void this.run(), this.config.get('RECONCILIATION_INTERVAL_MS'));
    handle.unref();
    this.scheduler.addInterval('reconciliation', handle);
  }

  async run(): Promise<{ checked: number; changed: number; failed: number }> {
    const stats = { checked: 0, changed: 0, failed: 0 };
    if (this.running) return stats;
    this.running = true;
    try {
      const now = Date.now();
      const candidates = await this.prisma.transaction.findMany({
        where: {
          status: { in: [...OPEN_STATUSES] },
          providerReference: { not: null },
          createdAt: { gte: new Date(now - LOOKBACK_DAYS * 86_400_000) },
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - this.config.get('RECONCILIATION_MIN_RESYNC_SECONDS') * 1000) } }],
        },
        orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
        take: this.config.get('RECONCILIATION_BATCH_SIZE'),
        select: { id: true },
      });
      for (const { id } of candidates) {
        stats.checked++;
        try {
          if ((await this.sync.execute(id, TransactionEventSource.RECONCILIATION)).changed) stats.changed++;
        } catch (err) {
          stats.failed++;
          this.logger.warn({ msg: 'reconciliation item failed', transactionId: id, err });
        }
      }
      const purged = await this.idempotency.purgeExpired();
      await this.warnExpiringCertificates();
      if (stats.checked > 0 || purged > 0) this.logger.log({ msg: 'reconciliation cycle', ...stats, idempotencyPurged: purged });
    } catch (err) {
      this.logger.error({ msg: 'reconciliation cycle failed', err });
    } finally {
      this.running = false;
    }
    return stats;
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
