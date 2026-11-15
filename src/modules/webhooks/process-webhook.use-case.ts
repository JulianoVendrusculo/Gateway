import { Injectable, Logger } from '@nestjs/common';
import { PaymentProvider, Prisma, TransactionEventSource, WebhookEventStatus } from '@prisma/client';
import { AppConfig } from '../../config/app-config';
import { PrismaService, isUniqueViolation } from '../../infra/database/prisma.service';
import { AttemptLifecycleService } from '../payments/application/attempt-lifecycle.service';
import { NormalizedWebhookEvent, ProviderPayment } from '../payments/domain/payment-gateway.port';
import { PaymentGatewayRegistry } from '../payments/gateways/payment-gateway.registry';

export interface WebhookSummary {
  received: number;
  processed: number;
  duplicated: number;
  ignored: number;
  failed: number;
}

const PAYMENT_EVENTS: ReadonlyArray<NormalizedWebhookEvent['type']> = ['PIX_RECEIVED', 'BOLETO_PAID', 'CARD_PAID'];

/**
 * Recepção de notificações bancárias na v2.
 *  - Idempotente pelo id do evento do banco (UNIQUE provider + event_key): reentrega não reprocessa.
 *  - O evento é só um gatilho: o pagamento é confirmado consultando o banco (getStatus) e registrado
 *    com a Charge bloqueada, pelo mesmo caminho do job. A primeira confirmação quita a cobrança;
 *    pagamento de cobrança já paga vira PAGO_DUPLICADO com pendência de estorno.
 *  - O que o evento acrescenta é a identidade do pagamento, quando a consulta ao banco não a traz
 *    (boleto): é ela que revela uma segunda liquidação do mesmo título.
 */
@Injectable()
export class ProcessWebhookUseCase {
  private readonly logger = new Logger(ProcessWebhookUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly lifecycle: AttemptLifecycleService,
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
    const ignore = async (reason: string, transactionId?: string) => {
      this.logger.warn({ msg: 'webhook event ignored', provider, eventKey: event.eventKey, reason });
      await finish(WebhookEventStatus.IGNORED, { errorMessage: reason, transactionId });
      return 'ignored' as const;
    };

    const candidates = await this.prisma.transaction.findMany({
      where: {
        provider,
        providerReference: event.providerReference,
        ...(event.convenioHint ? { convenio: { settings: { path: [event.convenioHint.settingsKey], equals: event.convenioHint.value } } } : {}),
      },
      take: 2,
    });
    if (candidates.length === 0) return ignore('transação não encontrada');
    if (candidates.length > 1) {
      const reason = 'referência ambígua entre convênios';
      this.logger.warn({ msg: 'webhook event failed', provider, eventKey: event.eventKey, reason });
      await finish(WebhookEventStatus.FAILED, { errorMessage: reason });
      return 'failed';
    }
    const tx = candidates[0];
    if (!tx.chargeId) return ignore('transação criada pela v1 (sem cobrança única)', tx.id);

    const payment: ProviderPayment | undefined = PAYMENT_EVENTS.includes(event.type)
      ? { id: event.paymentId, amountCents: event.amountCents, paidAt: event.occurredAt }
      : undefined;
    try {
      if (this.config.get('WEBHOOK_CONFIRM_WITH_PROVIDER')) {
        await this.lifecycle.advance(tx.id, TransactionEventSource.WEBHOOK, { eventPayment: payment, includeSettled: true });
      } else if (payment) {
        await this.lifecycle.settleTrusted(tx.id, payment, TransactionEventSource.WEBHOOK);
      }
      await finish(WebhookEventStatus.PROCESSED, { transactionId: tx.id });
      return 'processed';
    } catch (err) {
      // Falha ao confirmar no banco: o evento fica FAILED (a reentrega o reprocessa) e o job garante a convergência.
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
}
