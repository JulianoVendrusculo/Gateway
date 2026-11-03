import { Injectable, Logger } from '@nestjs/common';
import { PaymentProvider, Prisma, Transaction, TransactionEventSource, WebhookEventStatus } from '@prisma/client';
import { AppConfig } from '../../config/app-config';
import { PrismaService, isUniqueViolation } from '../../infra/database/prisma.service';
import { SyncPaymentStatusUseCase } from '../payments/application/sync-payment-status.use-case';
import { TransactionRepository } from '../payments/application/transaction.repository';
import { NormalizedWebhookEvent } from '../payments/domain/payment-gateway.port';
import { canTransition } from '../payments/domain/transaction-state-machine';
import { PaymentGatewayRegistry } from '../payments/gateways/payment-gateway.registry';

export interface WebhookSummary {
  received: number;
  processed: number;
  duplicated: number;
  ignored: number;
  failed: number;
}

@Injectable()
export class ProcessWebhookUseCase {
  private readonly logger = new Logger(ProcessWebhookUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly sync: SyncPaymentStatusUseCase,
    private readonly transactions: TransactionRepository,
    private readonly config: AppConfig,
  ) {}

  async execute(provider: PaymentProvider, payload: unknown): Promise<WebhookSummary> {
    const events = this.registry.get(provider).parseWebhook(payload);
    const summary: WebhookSummary = { received: events.length, processed: 0, duplicated: 0, ignored: 0, failed: 0 };
    if (events.length === 0) {
      this.logger.warn({ msg: 'webhook payload not recognized', provider });
      return summary;
    }
    for (const event of events) {
      summary[await this.handle(provider, event)]++;
    }
    this.logger.log({ msg: 'webhook processed', provider, ...summary });
    return summary;
  }

  private async handle(provider: PaymentProvider, event: NormalizedWebhookEvent): Promise<Exclude<keyof WebhookSummary, 'received'>> {
    const record = await this.register(provider, event);
    if (!record) return 'duplicated';

    const finish = (status: WebhookEventStatus, data: { transactionId?: string; errorMessage?: string } = {}) =>
      this.prisma.webhookEvent.update({ where: { id: record.id }, data: { status, processedAt: new Date(), ...data } });

    const candidates = await this.prisma.transaction.findMany({
      where: {
        provider,
        providerReference: event.providerReference,
        ...(event.convenioHint ? { convenio: { settings: { path: [event.convenioHint.settingsKey], equals: event.convenioHint.value } } } : {}),
      },
      take: 2,
    });
    if (candidates.length !== 1) {
      const reason = candidates.length === 0 ? 'transação não encontrada' : 'referência ambígua entre convênios';
      this.logger.warn({ msg: 'webhook event ignored', provider, eventKey: event.eventKey, reason });
      await finish(candidates.length === 0 ? WebhookEventStatus.IGNORED : WebhookEventStatus.FAILED, { errorMessage: reason });
      return candidates.length === 0 ? 'ignored' : 'failed';
    }
    const tx = candidates[0];

    try {
      if (this.config.get('WEBHOOK_CONFIRM_WITH_PROVIDER')) {
        await this.sync.execute(tx.id, TransactionEventSource.WEBHOOK);
      } else {
        await this.applyTrusted(tx, event);
      }
      await finish(WebhookEventStatus.PROCESSED, { transactionId: tx.id });
      return 'processed';
    } catch (err) {
      // Falha ao confirmar no banco: o evento fica FAILED e a reconciliação ativa garante a convergência.
      this.logger.error({ msg: 'webhook event processing failed', provider, eventKey: event.eventKey, transactionId: tx.id, err });
      await finish(WebhookEventStatus.FAILED, { transactionId: tx.id, errorMessage: (err as Error).message?.slice(0, 500) });
      return 'failed';
    }
  }

  /** Deduplicação pela chave natural do evento (ex.: endToEndId). Reprocessa eventos que falharam antes. */
  private async register(provider: PaymentProvider, event: NormalizedWebhookEvent) {
    try {
      return await this.prisma.webhookEvent.create({
        data: {
          provider,
          eventKey: event.eventKey,
          eventType: event.type,
          providerReference: event.providerReference,
          status: WebhookEventStatus.RECEIVED,
          payload: event.raw as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.webhookEvent.findUnique({ where: { provider_eventKey: { provider, eventKey: event.eventKey } } });
      return existing && existing.status === WebhookEventStatus.FAILED ? existing : null;
    }
  }

  /** Modo sem reconsulta (WEBHOOK_CONFIRM_WITH_PROVIDER=false): só para ambientes controlados. */
  private async applyTrusted(tx: Transaction, event: NormalizedWebhookEvent): Promise<void> {
    if (event.type !== 'PIX_RECEIVED' && event.type !== 'BOLETO_PAID') return;
    if (!canTransition(tx.status, 'PAID')) return;
    await this.transactions.transition(
      tx.id,
      tx.status,
      'PAID',
      { paidAt: event.occurredAt ?? new Date(), paidAmountCents: event.amountCents ?? tx.amountCents },
      { type: 'status.webhook_trusted', source: TransactionEventSource.WEBHOOK, data: { eventKey: event.eventKey } },
    );
  }
}
