import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentProvider, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { BankRejectedError, BankTimeoutError, UnsupportedPaymentMethodError } from '../../../../common/errors';
import { isLuhnValid } from '../../../../common/validation/decorators';
import {
  CardChargeRequest,
  CardTokenResult,
  ChargeReference,
  ChargeRequest,
  ChargeResult,
  ChargeStatusResult,
  ConvenioValidationInput,
  GatewayContext,
  ICardTokenizer,
  IPaymentGateway,
  NormalizedWebhookEvent,
  RawCardData,
  ValidatedConvenioConfig,
} from '../../domain/payment-gateway.port';
import { assertNoProblems, parseConvenioPart } from '../shared/convenio-validation';

const PROVIDER = PaymentProvider.MOCK_ACQUIRER;

const settingsSchema = z.object({ simulatedLatencyMs: z.number().int().min(0).max(5000).default(0) }).strict();
const credentialsSchema = z.object({ acquirerToken: z.string().min(16).max(500) }).strict();

interface VaultEntry {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  fingerprint: string;
  convenioId: string;
}

interface MockCharge {
  status: TransactionStatus;
  amountCents: number;
  paidAt?: Date;
}

/**
 * Adquirente SIMULADA — mesma interface que uma adquirente real (Cielo, Rede, Getnet, Stone...).
 *
 * Modelo PCI-DSS: o PAN e o CVV existem só durante a chamada de tokenização e são
 * imediatamente descartados; o "cofre" guarda apenas metadados (bandeira, last4, validade).
 * Em produção o cofre é o da adquirente/token service provider — o gateway só guarda o token.
 *
 * Cartões de teste (final do PAN):
 *   ...0002 → recusado (CARD_DECLINED) | ...0028 → timeout da adquirente | demais Luhn-válidos → aprovado
 */
@Injectable()
export class MockAcquirerAdapter implements IPaymentGateway, ICardTokenizer {
  readonly provider = PROVIDER;
  readonly supportedMethods: ReadonlySet<PaymentMethod> = new Set([PaymentMethod.CREDIT_CARD]);
  private readonly logger = new Logger(MockAcquirerAdapter.name);
  private readonly vault = new Map<string, VaultEntry>();
  private readonly charges = new Map<string, MockCharge>();
  private readonly fingerprintKey = randomBytes(32);

  validateConvenio(input: ConvenioValidationInput): ValidatedConvenioConfig {
    const settings = parseConvenioPart(settingsSchema, input.settings, 'settings');
    const credentials = parseConvenioPart(credentialsSchema, input.credentials, 'credentials');
    assertNoProblems(input.environment === ProviderEnvironment.PRODUCTION ? ['a adquirente mock não pode ser usada em PRODUCTION'] : []);
    return { settings, credentials, urls: [] };
  }

  async tokenizeCard(ctx: GatewayContext, card: RawCardData): Promise<CardTokenResult> {
    await this.latency(ctx);
    const operation = 'card.tokenize';
    if (!isLuhnValid(card.number)) {
      throw new BankRejectedError({ provider: PROVIDER, operation, bankErrorCode: 'INVALID_CARD_NUMBER', bankMessage: 'Número de cartão inválido' });
    }
    const now = new Date();
    const expired = card.expYear < now.getUTCFullYear() || (card.expYear === now.getUTCFullYear() && card.expMonth < now.getUTCMonth() + 1);
    if (expired) throw new BankRejectedError({ provider: PROVIDER, operation, bankErrorCode: 'EXPIRED_CARD', bankMessage: 'Cartão expirado' });

    const token = `tok_mock_${randomBytes(18).toString('base64url')}`;
    const entry: VaultEntry = {
      brand: detectBrand(card.number),
      last4: card.number.slice(-4),
      expMonth: card.expMonth,
      expYear: card.expYear,
      fingerprint: createHmac('sha256', this.fingerprintKey).update(card.number).digest('hex').slice(0, 32),
      convenioId: ctx.convenioId,
    };
    this.vault.set(token, entry);
    return { token, brand: entry.brand, last4: entry.last4, expMonth: entry.expMonth, expYear: entry.expYear, fingerprint: entry.fingerprint };
  }

  providerReferenceFor(): string | undefined {
    return undefined; // TID é atribuído pela adquirente
  }

  async createCharge(ctx: GatewayContext, request: ChargeRequest): Promise<ChargeResult> {
    if (request.method !== PaymentMethod.CREDIT_CARD) throw new UnsupportedPaymentMethodError(PROVIDER, request.method);
    return this.authorize(ctx, request);
  }

  async getChargeStatus(ctx: GatewayContext, ref: ChargeReference): Promise<ChargeStatusResult> {
    await this.latency(ctx);
    const charge = this.charges.get(ref.providerReference);
    if (!charge) return { status: TransactionStatus.PROCESSING, providerStatus: 'NOT_FOUND' };
    return { status: charge.status, providerStatus: charge.status, paidAmountCents: charge.paidAt ? charge.amountCents : undefined, paidAt: charge.paidAt };
  }

  parseWebhook(): NormalizedWebhookEvent[] {
    return [];
  }

  private async authorize(ctx: GatewayContext, req: CardChargeRequest): Promise<ChargeResult> {
    await this.latency(ctx);
    const operation = 'card.authorize';
    const card = this.vault.get(req.cardToken);
    if (!card || card.convenioId !== ctx.convenioId) {
      throw new BankRejectedError({ provider: PROVIDER, operation, bankErrorCode: 'INVALID_TOKEN', bankMessage: 'Token de cartão inválido ou expirado' });
    }
    if (card.last4 === '0028') throw new BankTimeoutError({ provider: PROVIDER, operation });

    const tid = `mock_${randomBytes(10).toString('hex')}`;
    const cardData = { brand: card.brand, last4: card.last4, installments: req.installments, tid };
    if (card.last4 === '0002') {
      this.charges.set(tid, { status: TransactionStatus.FAILED, amountCents: req.amountCents });
      return {
        status: TransactionStatus.FAILED,
        providerReference: tid,
        providerData: { card: cardData },
        failure: { code: 'CARD_DECLINED', message: 'Transação não autorizada pelo emissor' },
      };
    }

    const status = req.capture ? TransactionStatus.PAID : TransactionStatus.AUTHORIZED;
    const paidAt = req.capture ? new Date() : undefined;
    this.charges.set(tid, { status, amountCents: req.amountCents, paidAt });
    this.logger.log({ msg: 'mock acquirer authorized', transactionId: req.transactionId, status });
    return {
      status,
      providerReference: tid,
      providerData: {
        card: { ...cardData, authorizationCode: randomInt(100000, 999999).toString(), nsu: randomInt(1e8, 1e9 - 1).toString() },
      },
      ...(paidAt ? { paidAt, paidAmountCents: req.amountCents } : {}),
    };
  }

  private async latency(ctx: GatewayContext): Promise<void> {
    const ms = settingsSchema.parse(ctx.settings).simulatedLatencyMs;
    if (ms > 0) await sleep(ms);
  }
}

export function detectBrand(pan: string): string {
  if (/^(4011(78|79)|43(1274|8935)|45(1416|7393|763(1|2))|50(4175|6699|67[0-7][0-9]|9000)|627780|63(6297|6368)|650(0|4|5)|65(16|50))/.test(pan)) return 'ELO';
  if (/^(606282|3841)/.test(pan)) return 'HIPERCARD';
  if (/^3[47]/.test(pan)) return 'AMEX';
  if (/^4/.test(pan)) return 'VISA';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(pan)) return 'MASTERCARD';
  return 'UNKNOWN';
}
