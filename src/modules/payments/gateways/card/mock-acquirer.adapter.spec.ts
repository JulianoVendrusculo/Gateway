import { Logger } from '@nestjs/common';
import { PaymentMethod, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { BankTimeoutError, BankUnavailableError, ConvenioValidationError, UnsupportedPaymentMethodError } from '../../../../common/errors';
import { ChargeReference, GatewayContext, HostedLinkCardChargeRequest } from '../../domain/payment-gateway.port';
import { MockAcquirerAdapter } from './mock-acquirer.adapter';

Logger.overrideLogger(false);

const context = (settings: Record<string, unknown> = {}, convenioId = 'c1') => ({ convenioId, settings, credentials: {} }) as unknown as GatewayContext;
const payer = { name: 'Maria', document: '52998224725', documentType: 'CPF' as const };
const linkRequest = (transactionId: string, linkTtlSeconds = 900): HostedLinkCardChargeRequest => ({
  method: PaymentMethod.CREDIT_CARD,
  mode: 'HOSTED_LINK',
  transactionId,
  amountCents: 1000,
  linkTtlSeconds,
  maxInstallments: 3,
  payer,
});
const refOf = (reference: string): ChargeReference => ({ transactionId: 't', method: PaymentMethod.CREDIT_CARD, providerReference: reference, amountCents: 1000, createdAt: new Date() });

describe('MockAcquirerAdapter (link de cartão simulado)', () => {
  const adapter = new MockAcquirerAdapter();
  const ctx = context();

  it('cria o link com validade curta e uma referência conhecida antes do envio', async () => {
    const request = linkRequest('8f0a6b8e-1c2d-4e5f-9a0b-1c2d3e4f5a6b', 600);
    expect(adapter.providerReferenceFor(ctx, request)).toBe('lnk_8f0a6b8e1c2d4e5f9a0b1c2d3e4f5a6b');
    const result = await adapter.createCharge(ctx, request);
    expect(result).toMatchObject({ status: TransactionStatus.PENDENTE, providerReference: 'lnk_8f0a6b8e1c2d4e5f9a0b1c2d3e4f5a6b' });
    expect(result.providerData.card).toEqual({ mode: 'HOSTED_LINK', paymentUrl: 'https://pagamento.exemplo.invalid/link/lnk_8f0a6b8e1c2d4e5f9a0b1c2d3e4f5a6b', maxInstallments: 3 });
    expect(result.expiresAt!.getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(result.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    expect(await adapter.getStatus(ctx, refOf(result.providerReference))).toEqual({ status: TransactionStatus.PENDENTE, providerStatus: 'OPEN' });
  });

  it('só oferece HOSTED_LINK: o modo DIRECT é recusado', async () => {
    expect([...adapter.cardModes]).toEqual(['HOSTED_LINK']);
    const direct = { method: PaymentMethod.CREDIT_CARD, mode: 'DIRECT' as const, transactionId: 't', amountCents: 1000, cardToken: 'tok', installments: 1, payer };
    await expect(adapter.createCharge(ctx, direct)).rejects.toBeInstanceOf(UnsupportedPaymentMethodError);
  });

  it('pagamento vira webhook e a consulta passa a informar o pagamento com seu id', async () => {
    const { providerReference } = await adapter.createCharge(ctx, linkRequest('11111111-2222-4333-8444-555555555555'));
    const webhook = adapter.simulatePayment(providerReference);
    const [event] = adapter.parseWebhook(webhook);
    expect(event).toMatchObject({ type: 'CARD_PAID', eventKey: `card:${webhook.paymentId}`, providerReference, paymentId: webhook.paymentId, amountCents: 1000 });
    expect(await adapter.getStatus(ctx, refOf(providerReference))).toMatchObject({ status: TransactionStatus.CONFIRMADA, payments: [{ id: webhook.paymentId, amountCents: 1000 }] });
    expect(adapter.parseWebhook({ type: 'outro' })).toEqual([]);
  });

  it('link vencido não aceita pagamento, a menos que o teste force (confirmação tardia e pagamento em dobro)', async () => {
    const { providerReference } = await adapter.createCharge(ctx, linkRequest('22222222-2222-4333-8444-555555555555'));
    adapter.simulateExpiration(providerReference);
    expect((await adapter.getStatus(ctx, refOf(providerReference))).status).toBe(TransactionStatus.EXPIRADA);
    expect(() => adapter.simulatePayment(providerReference)).toThrow(/não aceita pagamento/);

    const first = adapter.simulatePayment(providerReference, { force: true });
    const second = adapter.simulatePayment(providerReference, { force: true });
    const status = await adapter.getStatus(ctx, refOf(providerReference));
    expect(status.payments?.map((p) => p.id)).toEqual([first.paymentId, second.paymentId]);
  });

  it('cancelamento: aceito, recusado por já estar pago, não oferecido, recusado e erro técnico', async () => {
    const open = (await adapter.createCharge(ctx, linkRequest('33333333-2222-4333-8444-555555555555'))).providerReference;
    expect(await adapter.cancel(ctx, refOf(open))).toEqual({ outcome: 'CANCELED', providerStatus: 'CANCELED' });
    expect((await adapter.getStatus(ctx, refOf(open))).status).toBe(TransactionStatus.CANCELADA);

    const paid = (await adapter.createCharge(ctx, linkRequest('44444444-2222-4333-8444-555555555555'))).providerReference;
    adapter.simulatePayment(paid);
    expect(await adapter.cancel(ctx, refOf(paid))).toMatchObject({ outcome: 'ALREADY_PAID', payments: [{ amountCents: 1000 }] });

    const other = (await adapter.createCharge(ctx, linkRequest('55555555-2222-4333-8444-555555555555'))).providerReference;
    expect(await adapter.cancel(context({ cancelBehavior: 'UNSUPPORTED' }), refOf(other))).toMatchObject({ outcome: 'NOT_SUPPORTED' });
    expect(await adapter.cancel(context({ cancelBehavior: 'REFUSE' }), refOf(other))).toMatchObject({ outcome: 'REFUSED', providerStatus: 'OPEN' });
    const failed = await adapter.cancel(context({ cancelBehavior: 'ERROR' }), refOf(other));
    expect(failed.outcome === 'TECHNICAL_ERROR' && failed.error).toBeInstanceOf(BankUnavailableError);
    expect((await adapter.getStatus(ctx, refOf(other))).status).toBe(TransactionStatus.PENDENTE);
  });

  it('timeout na criação não registra o link, e a consulta posterior responde 404', async () => {
    const request = linkRequest('66666666-2222-4333-8444-555555555555');
    await expect(adapter.createCharge(context({ createBehavior: 'TIMEOUT' }), request)).rejects.toBeInstanceOf(BankTimeoutError);
    await expect(adapter.getStatus(ctx, refOf(adapter.providerReferenceFor(ctx, request)!))).rejects.toMatchObject({ bankHttpStatus: 404 });
  });

  it('link de outro convênio não é visível', async () => {
    const { providerReference } = await adapter.createCharge(ctx, linkRequest('77777777-2222-4333-8444-555555555555'));
    await expect(adapter.getStatus(context({}, 'outro'), refOf(providerReference))).rejects.toMatchObject({ bankHttpStatus: 404 });
  });

  it('não pode ser usado em produção', () => {
    expect(() =>
      adapter.validateConvenio({ environment: ProviderEnvironment.PRODUCTION, supportedMethods: [PaymentMethod.CREDIT_CARD], settings: {}, credentials: { acquirerToken: 'x'.repeat(16) }, hasCertificate: false }),
    ).toThrow(ConvenioValidationError);
  });
});
