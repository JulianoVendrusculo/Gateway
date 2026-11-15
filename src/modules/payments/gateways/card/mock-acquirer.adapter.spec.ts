import { Logger } from '@nestjs/common';
import { PaymentMethod, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { BankRejectedError, BankTimeoutError, ConvenioValidationError } from '../../../../common/errors';
import { GatewayContext } from '../../domain/payment-gateway.port';
import { MockAcquirerAdapter, detectBrand } from './mock-acquirer.adapter';

Logger.overrideLogger(false);

const ctx = { convenioId: 'c1', settings: {}, credentials: {} } as unknown as GatewayContext;
const card = (number: string) => ({ number, holderName: 'MARIA', expMonth: 12, expYear: new Date().getUTCFullYear() + 2, cvv: '123' });
const payer = { name: 'Maria', document: '52998224725', documentType: 'CPF' as const };
const charge = (cardToken: string, capture = true) => ({ method: PaymentMethod.CREDIT_CARD, transactionId: 't', amountCents: 1000, cardToken, installments: 1, capture, payer });

describe('MockAcquirerAdapter', () => {
  const adapter = new MockAcquirerAdapter();

  it('tokeniza sem reter PAN/CVV e aprova com captura', async () => {
    const tok = await adapter.tokenizeCard(ctx, card('4111111111111111'));
    expect(tok).toMatchObject({ brand: 'VISA', last4: '1111' });
    expect(JSON.stringify(tok)).not.toContain('4111111111111111');
    const result = await adapter.createCharge(ctx, charge(tok.token));
    expect(result.status).toBe(TransactionStatus.PAID);
    expect(result.providerData.card?.authorizationCode).toMatch(/^\d{6}$/);
  });

  it('pré-autoriza quando capture=false', async () => {
    const tok = await adapter.tokenizeCard(ctx, card('5555555555554444'));
    expect((await adapter.createCharge(ctx, charge(tok.token, false))).status).toBe(TransactionStatus.AUTHORIZED);
  });

  it('cartão de teste ...0002 é recusado como resultado (não exceção)', async () => {
    const tok = await adapter.tokenizeCard(ctx, card('4000000000000002'));
    const result = await adapter.createCharge(ctx, charge(tok.token));
    expect(result).toMatchObject({ status: TransactionStatus.FAILED, failure: { code: 'CARD_DECLINED' } });
  });

  it('cartão ...0028 simula timeout (resultado incerto) e a consulta posterior não encontra a cobrança', async () => {
    const tok = await adapter.tokenizeCard(ctx, card('4000000000000028'));
    const request = { ...charge(tok.token), transactionId: '8f0a6b8e-1c2d-4e5f-9a0b-1c2d3e4f5a6b' };
    const reference = adapter.providerReferenceFor(ctx, request);
    expect(reference).toBe('ord_8f0a6b8e1c2d4e5f9a0b1c2d3e4f5a6b');
    await expect(adapter.createCharge(ctx, request)).rejects.toBeInstanceOf(BankTimeoutError);
    const lookup = adapter.getChargeStatus(ctx, { transactionId: request.transactionId, method: PaymentMethod.CREDIT_CARD, providerReference: reference!, amountCents: 1000, createdAt: new Date() });
    await expect(lookup).rejects.toMatchObject({ bankHttpStatus: 404, bankErrorCode: 'CHARGE_NOT_FOUND' });
  });

  it('a referência conhecida antes do envio localiza a cobrança aprovada', async () => {
    const tok = await adapter.tokenizeCard(ctx, card('4111111111111111'));
    const request = { ...charge(tok.token), transactionId: '11111111-2222-4333-8444-555555555555' };
    const reference = adapter.providerReferenceFor(ctx, request)!;
    expect((await adapter.createCharge(ctx, request)).providerReference).toBe(reference);
    const status = await adapter.getChargeStatus(ctx, { transactionId: request.transactionId, method: PaymentMethod.CREDIT_CARD, providerReference: reference, amountCents: 1000, createdAt: new Date() });
    expect(status).toMatchObject({ status: TransactionStatus.PAID, paidAmountCents: 1000 });
  });

  it('token de outro convênio ou inexistente é rejeitado', async () => {
    const tok = await adapter.tokenizeCard(ctx, card('4111111111111111'));
    await expect(adapter.createCharge({ ...ctx, convenioId: 'other' }, charge(tok.token))).rejects.toBeInstanceOf(BankRejectedError);
  });

  it('não pode ser usado em produção', () => {
    expect(() =>
      adapter.validateConvenio({ environment: ProviderEnvironment.PRODUCTION, supportedMethods: [PaymentMethod.CREDIT_CARD], settings: {}, credentials: { acquirerToken: 'x'.repeat(16) }, hasCertificate: false }),
    ).toThrow(ConvenioValidationError);
  });

  it('detecta bandeiras', () => {
    expect(detectBrand('5067000000000000')).toBe('ELO');
    expect(detectBrand('6062820000000000')).toBe('HIPERCARD');
    expect(detectBrand('378282246310005')).toBe('AMEX');
    expect(detectBrand('2221000000000009')).toBe('MASTERCARD');
  });
});
