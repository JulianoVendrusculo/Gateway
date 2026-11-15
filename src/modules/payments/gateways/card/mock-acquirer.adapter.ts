import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentProvider, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { BankRejectedError, BankTimeoutError, BankUnavailableError, UnsupportedPaymentMethodError } from '../../../../common/errors';
import {
  CancelResult,
  CardMode,
  ChargeReference,
  ChargeRequest,
  ChargeResult,
  ChargeStatusResult,
  ConvenioValidationInput,
  GatewayContext,
  IPaymentGateway,
  NormalizedWebhookEvent,
  ProviderPayment,
  ValidatedConvenioConfig,
} from '../../domain/payment-gateway.port';
import { assertNoProblems, parseConvenioPart } from '../shared/convenio-validation';

const PROVIDER = PaymentProvider.MOCK_ACQUIRER;

/**
 * Comportamentos do "banco" que ainda dependem de confirmação com BB e Caixa.
 * Cada um é uma chave do convênio, para os testes exercitarem todos os caminhos.
 */
const settingsSchema = z
  .object({
    simulatedLatencyMs: z.number().int().min(0).max(5000).default(0),
    /** Endereço da página de pagamento devolvido ao pagador. O gateway nunca chama esta URL. */
    linkBaseUrl: z.string().url().default('https://pagamento.exemplo.invalid/link'),
    /** OK: cria o link. TIMEOUT: não cria e o resultado fica incerto. */
    createBehavior: z.enum(['OK', 'TIMEOUT']).default('OK'),
    /**
     * Resposta ao pedido de invalidar o link:
     * ACCEPT invalida; UNSUPPORTED = o banco não oferece cancelamento; REFUSE recusa; ERROR = falha técnica.
     */
    cancelBehavior: z.enum(['ACCEPT', 'UNSUPPORTED', 'REFUSE', 'ERROR']).default('ACCEPT'),
  })
  .strict();
const credentialsSchema = z.object({ acquirerToken: z.string().min(16).max(500) }).strict();

const webhookSchema = z.object({
  type: z.literal('payment.confirmed'),
  reference: z.string().regex(/^lnk_[a-f0-9]{32}$/),
  paymentId: z.string().regex(/^pay_[a-f0-9]{20}$/),
  amountCents: z.number().int().positive(),
  paidAt: z.string(),
});

export type MockAcquirerWebhook = z.infer<typeof webhookSchema>;

interface MockLink {
  convenioId: string;
  amountCents: number;
  expiresAt: Date;
  canceled: boolean;
  payments: Array<Required<ProviderPayment>>;
}

/**
 * Provedor SIMULADO de link de pagamento com cartão (modo HOSTED_LINK): o pagador sai da plataforma
 * e paga na página do banco; a confirmação chega depois, por webhook.
 *
 * TODO(BB e Caixa): nenhuma API oficial de link de cartão dos dois bancos foi identificada nesta
 * entrega. Falta definir o produto (e a adquirente por trás dele) e implementar um adapter real com
 * este mesmo contrato. Até lá ficam simulados, e precisam ser confirmados com o banco:
 *   - se existe API para invalidar um link, e se a invalidação é imediata;
 *   - a validade mínima e máxima do link;
 *   - se um mesmo link pode ser pago mais de uma vez;
 *   - o atraso típico e o máximo do webhook de confirmação, e o formato dele.
 *
 * O estado fica em memória (uma instância só) e o provedor é bloqueado em PRODUCTION.
 */
@Injectable()
export class MockAcquirerAdapter implements IPaymentGateway {
  readonly provider = PROVIDER;
  readonly supportedMethods: ReadonlySet<PaymentMethod> = new Set([PaymentMethod.CREDIT_CARD]);
  readonly cardModes: ReadonlySet<CardMode> = new Set<CardMode>(['HOSTED_LINK']);
  private readonly logger = new Logger(MockAcquirerAdapter.name);
  private readonly links = new Map<string, MockLink>();

  validateConvenio(input: ConvenioValidationInput): ValidatedConvenioConfig {
    const settings = parseConvenioPart(settingsSchema, input.settings, 'settings');
    const credentials = parseConvenioPart(credentialsSchema, input.credentials, 'credentials');
    assertNoProblems(input.environment === ProviderEnvironment.PRODUCTION ? ['o provedor simulado de link de cartão não pode ser usado em PRODUCTION'] : []);
    return { settings, credentials, urls: [] };
  }

  /** Papel do id do pedido nas adquirentes reais: conhecido antes do envio, permite consultar depois de um timeout. */
  providerReferenceFor(_ctx: GatewayContext, request: ChargeRequest): string | undefined {
    return request.method === PaymentMethod.CREDIT_CARD ? `lnk_${request.transactionId.replace(/-/g, '')}` : undefined;
  }

  async createCharge(ctx: GatewayContext, request: ChargeRequest): Promise<ChargeResult> {
    if (request.method !== PaymentMethod.CREDIT_CARD || request.mode !== 'HOSTED_LINK') {
      throw new UnsupportedPaymentMethodError(PROVIDER, request.method === PaymentMethod.CREDIT_CARD ? `CREDIT_CARD/${request.mode}` : request.method);
    }
    const settings = await this.settings(ctx);
    if (settings.createBehavior === 'TIMEOUT') throw new BankTimeoutError({ provider: PROVIDER, operation: 'card.link.create' });

    const reference = this.providerReferenceFor(ctx, request)!;
    const expiresAt = new Date(Date.now() + request.linkTtlSeconds * 1000);
    this.links.set(reference, { convenioId: ctx.convenioId, amountCents: request.amountCents, expiresAt, canceled: false, payments: [] });
    this.logger.log({ msg: 'mock card link created', transactionId: request.transactionId, expiresAt });
    return {
      status: TransactionStatus.PENDENTE,
      providerReference: reference,
      providerData: { card: { mode: 'HOSTED_LINK', paymentUrl: `${settings.linkBaseUrl}/${reference}`, maxInstallments: request.maxInstallments } },
      expiresAt,
    };
  }

  async getStatus(ctx: GatewayContext, ref: ChargeReference): Promise<ChargeStatusResult> {
    await this.settings(ctx);
    const link = this.find(ctx, ref.providerReference);
    if (!link) {
      // Mesmo contrato de um 404 real: passada a carência, conclui-se que o link nunca foi criado.
      throw new BankRejectedError({ provider: PROVIDER, operation: 'card.link.get', bankHttpStatus: 404, bankErrorCode: 'LINK_NOT_FOUND', bankMessage: 'Link não encontrado' });
    }
    if (link.payments.length > 0) return { status: TransactionStatus.CONFIRMADA, providerStatus: 'PAID', payments: link.payments };
    if (link.canceled) return { status: TransactionStatus.CANCELADA, providerStatus: 'CANCELED' };
    if (link.expiresAt.getTime() <= Date.now()) return { status: TransactionStatus.EXPIRADA, providerStatus: 'EXPIRED' };
    return { status: TransactionStatus.PENDENTE, providerStatus: 'OPEN' };
  }

  async cancel(ctx: GatewayContext, ref: ChargeReference): Promise<CancelResult> {
    const settings = await this.settings(ctx);
    const operation = 'card.link.cancel';
    if (settings.cancelBehavior === 'UNSUPPORTED') return { outcome: 'NOT_SUPPORTED', reason: 'o provedor não oferece cancelamento de link de pagamento' };
    if (settings.cancelBehavior === 'ERROR') return { outcome: 'TECHNICAL_ERROR', error: new BankUnavailableError({ provider: PROVIDER, operation }, 'UNCERTAIN') };

    const link = this.find(ctx, ref.providerReference);
    if (!link) return { outcome: 'TECHNICAL_ERROR', error: new BankRejectedError({ provider: PROVIDER, operation, bankHttpStatus: 404, bankErrorCode: 'LINK_NOT_FOUND' }) };
    if (link.payments.length > 0) return { outcome: 'ALREADY_PAID', providerStatus: 'PAID', payments: link.payments };
    if (settings.cancelBehavior === 'REFUSE') return { outcome: 'REFUSED', providerStatus: 'OPEN', reason: 'cancelamento recusado pelo provedor' };
    link.canceled = true;
    return { outcome: 'CANCELED', providerStatus: 'CANCELED' };
  }

  parseWebhook(payload: unknown): NormalizedWebhookEvent[] {
    const parsed = webhookSchema.safeParse(payload);
    if (!parsed.success) return [];
    const event = parsed.data;
    return [
      {
        eventKey: `card:${event.paymentId}`,
        type: 'CARD_PAID',
        providerReference: event.reference,
        paymentId: event.paymentId,
        amountCents: event.amountCents,
        occurredAt: new Date(event.paidAt),
        raw: event,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Ganchos de simulação: fazem o papel do pagador na página do banco.
  // ---------------------------------------------------------------------------

  /**
   * Registra um pagamento no link e devolve o webhook que o banco enviaria.
   * Por padrão só aceita link aberto. `force` simula o que ainda não se sabe se o banco impede:
   * pagamento com o link vencido ou cancelado (confirmação tardia) e segundo pagamento do mesmo link.
   */
  simulatePayment(reference: string, options: { force?: boolean } = {}): MockAcquirerWebhook {
    const link = this.links.get(reference);
    if (!link) throw new Error(`link desconhecido: ${reference}`);
    const open = !link.canceled && link.payments.length === 0 && link.expiresAt.getTime() > Date.now();
    if (!open && !options.force) throw new Error('o link não aceita pagamento (vencido, cancelado ou já pago)');
    const payment = { id: `pay_${randomBytes(10).toString('hex')}`, amountCents: link.amountCents, paidAt: new Date() };
    link.payments.push(payment);
    return { type: 'payment.confirmed', reference, paymentId: payment.id, amountCents: payment.amountCents, paidAt: payment.paidAt.toISOString() };
  }

  /** Antecipa o vencimento do link no provedor (os testes não esperam o relógio). */
  simulateExpiration(reference: string): void {
    const link = this.links.get(reference);
    if (!link) throw new Error(`link desconhecido: ${reference}`);
    link.expiresAt = new Date(Date.now() - 1000);
  }

  private find(ctx: GatewayContext, reference: string): MockLink | undefined {
    const link = this.links.get(reference);
    return link && link.convenioId === ctx.convenioId ? link : undefined;
  }

  private async settings(ctx: GatewayContext): Promise<z.infer<typeof settingsSchema>> {
    const settings = settingsSchema.parse(ctx.settings);
    if (settings.simulatedLatencyMs > 0) await sleep(settings.simulatedLatencyMs);
    return settings;
  }
}
