import { Logger } from '@nestjs/common';
import { PaymentMethod, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { MockAgent } from 'undici';
import { BankAuthenticationError, BankRejectedError, BankUnavailableError, ConvenioValidationError } from '../../../../common/errors';
import { parseIsoDate } from '../../../../common/utils/date-helpers';
import { BankHttpClient } from '../../../../infra/http/bank-http-client';
import { barcodeToDigitableLine, buildBarcode } from '../../boleto/boleto-barcode';
import { GatewayContext } from '../../domain/payment-gateway.port';
import { isValidBrCode } from '../../pix/pix-brcode';
import { OAuth2TokenProvider } from '../shared/oauth2-token.provider';
import { BancoDoBrasilAdapter } from './bb.adapter';

Logger.overrideLogger(false);

const OAUTH = 'https://oauth.hm.bb.com.br';
const API = 'https://api.hm.bb.com.br';

const settings = {
  numeroConvenio: 3128557,
  numeroCarteira: 17,
  numeroVariacaoCarteira: 35,
  pixMerchantName: 'Loja Exemplo',
  pixMerchantCity: 'Brasilia',
};

function setup() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const http = new BankHttpClient({ provider: 'BANCO_DO_BRASIL', dispatcher: agent, defaultTimeoutMs: 2000, baseBackoffMs: 1 });
  const ctx: GatewayContext = {
    convenioId: 'conv-1',
    credentialsVersion: 1,
    environment: ProviderEnvironment.SANDBOX,
    settings,
    credentials: { clientId: 'id', clientSecret: 'secret', developerAppKey: 'devkey', pixKey: 'pix@loja.com' },
    http,
    beneficiary: { name: 'Loja', document: '11222333000181' },
  };
  const adapter = new BancoDoBrasilAdapter(new OAuth2TokenProvider());
  const payer = { name: 'Maria Silva', document: '52998224725', documentType: 'CPF' as const };
  return { agent, ctx, adapter, payer };
}

function mockToken(agent: MockAgent, times = 1) {
  agent
    .get(OAUTH)
    .intercept({ path: '/oauth/token', method: 'POST' })
    .reply(200, { access_token: 'tkn', token_type: 'Bearer', expires_in: 600 })
    .times(times);
}

describe('BancoDoBrasilAdapter', () => {
  it('valida convênio: exige chave Pix e certificado em produção', () => {
    const { adapter } = setup();
    expect(() =>
      adapter.validateConvenio({
        environment: ProviderEnvironment.PRODUCTION,
        supportedMethods: [PaymentMethod.PIX],
        settings,
        credentials: { clientId: 'a', clientSecret: 'b', developerAppKey: 'c' },
        hasCertificate: false,
      }),
    ).toThrow(ConvenioValidationError);
  });

  it('cria cobrança Pix e monta o copia-e-cola a partir do location quando o PSP não o devolve', async () => {
    const { agent, ctx, adapter, payer } = setup();
    mockToken(agent);
    let sentBody: Record<string, unknown> = {};
    agent
      .get(API)
      .intercept({ path: (p) => p.startsWith('/pix/v2/cob/TXID123') && p.includes('gw-dev-app-key=devkey'), method: 'PUT' })
      .reply(201, (opts) => {
        sentBody = JSON.parse(String(opts.body));
        return {
          txid: 'TXID123',
          status: 'ATIVA',
          calendario: { criacao: '2026-10-30T12:00:00Z', expiracao: 3600 },
          location: 'qrcodepix.bb.com.br/pix/v2/abc',
          valor: { original: '150.50' },
        };
      });

    const result = await adapter.createCharge(ctx, {
      method: PaymentMethod.PIX,
      transactionId: 't1',
      txid: 'TXID123',
      amountCents: 15050,
      expiresInSeconds: 3600,
      payer,
    });

    expect(sentBody).toMatchObject({ valor: { original: '150.50' }, chave: 'pix@loja.com', devedor: { cpf: '52998224725' } });
    expect(result.status).toBe(TransactionStatus.PENDING);
    expect(result.providerReference).toBe('TXID123');
    expect(isValidBrCode(result.providerData.pix!.copyPaste)).toBe(true);
    expect(result.expiresAt?.toISOString()).toBe('2026-10-30T13:00:00.000Z');
  });

  it('renova o token e repete uma vez quando a API responde 401', async () => {
    const { agent, ctx, adapter } = setup();
    mockToken(agent, 2);
    const api = agent.get(API);
    api.intercept({ path: (p) => p.startsWith('/pix/v2/cob/T1'), method: 'GET' }).reply(401, { error: 'invalid_token' });
    api.intercept({ path: (p) => p.startsWith('/pix/v2/cob/T1'), method: 'GET' }).reply(200, {
      txid: 'T1',
      status: 'CONCLUIDA',
      calendario: { criacao: '2026-10-30T12:00:00Z', expiracao: 3600 },
      valor: { original: '10.00' },
      pix: [{ endToEndId: 'E1', txid: 'T1', valor: '10.00', horario: '2026-10-30T12:05:00Z' }],
    });
    const status = await adapter.getChargeStatus(ctx, {
      transactionId: 't',
      method: PaymentMethod.PIX,
      providerReference: 'T1',
      amountCents: 1000,
      createdAt: new Date(),
    });
    expect(status).toMatchObject({ status: TransactionStatus.PAID, paidAmountCents: 1000 });
  });

  it('falha de OAuth vira BankAuthenticationError', async () => {
    const { agent, ctx, adapter } = setup();
    agent.get(OAUTH).intercept({ path: '/oauth/token', method: 'POST' }).reply(401, { error: 'invalid_client', error_description: 'bad' });
    await expect(
      adapter.getChargeStatus(ctx, { transactionId: 't', method: PaymentMethod.PIX, providerReference: 'X', amountCents: 1, createdAt: new Date() }),
    ).rejects.toBeInstanceOf(BankAuthenticationError);
  });

  describe('boleto', () => {
    const barcode = buildBarcode({ bankCode: '001', dueDate: parseIsoDate('2026-11-15'), amountCents: 15050, freeField: '0000003128557000000000117' });
    const request = {
      method: PaymentMethod.BOLETO,
      transactionId: '8f0a6b8e-1c2d-4e5f-9a0b-1c2d3e4f5a6b',
      amountCents: 15050,
      sequence: 1n,
      dueDate: parseIsoDate('2026-11-15'),
      issueDate: parseIsoDate('2026-10-30'),
      instructions: ['Não receber após 30 dias'],
      payer: {
        name: 'José da Silva',
        document: '52998224725',
        documentType: 'CPF' as const,
        address: { street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'Brasília', state: 'DF', zipCode: '70000-000' },
      },
    } as const;

    it('registra boleto com nosso número composto e normaliza linha digitável', async () => {
      const { agent, ctx, adapter } = setup();
      mockToken(agent);
      let sent: Record<string, any> = {};
      agent
        .get(API)
        .intercept({ path: (p) => p.startsWith('/cobrancas/v2/boletos?'), method: 'POST' })
        .reply(201, (opts) => {
          sent = JSON.parse(String(opts.body));
          return { numero: '00031285570000000001', linhaDigitavel: barcodeToDigitableLine(barcode), codigoBarraNumerico: barcode };
        });
      const result = await adapter.createCharge(ctx, { ...request, instructions: [...request.instructions] });
      expect(sent).toMatchObject({
        numeroTituloCliente: '00031285570000000001',
        dataVencimento: '15.11.2026',
        valorOriginal: 150.5,
        pagador: { tipoInscricao: 1, numeroInscricao: 52998224725, nome: 'JOSE DA SILVA', cidade: 'BRASILIA', cep: 70000000 },
      });
      expect(result.providerReference).toBe('00031285570000000001');
      expect(result.providerData.boleto).toMatchObject({ barcode, dueDate: '2026-11-15' });
    });

    it('recusa do banco expõe mensagem e código', async () => {
      const { agent, ctx, adapter } = setup();
      mockToken(agent);
      agent
        .get(API)
        .intercept({ path: (p) => p.startsWith('/cobrancas/v2/boletos?'), method: 'POST' })
        .reply(400, { erros: [{ codigo: '4874915', mensagem: 'CEP do pagador inválido' }] });
      const err = await adapter.createCharge(ctx, { ...request, instructions: [] }).catch((e) => e);
      expect(err).toBeInstanceOf(BankRejectedError);
      expect(err.details).toMatchObject({ bankErrorCode: '4874915', bankMessage: 'CEP do pagador inválido' });
    });

    it('5xx no registro é resultado INCERTO e não é retentado (POST não idempotente)', async () => {
      const { agent, ctx, adapter } = setup();
      mockToken(agent);
      agent.get(API).intercept({ path: (p) => p.startsWith('/cobrancas/v2/boletos?'), method: 'POST' }).reply(503, 'unavailable').times(1);
      const err = await adapter.createCharge(ctx, { ...request, instructions: [] }).catch((e) => e);
      expect(err).toBeInstanceOf(BankUnavailableError);
      expect(err.outcome).toBe('UNCERTAIN');
      agent.assertNoPendingInterceptors();
    });
  });

  it('normaliza webhooks de Pix (padrão BACEN) e de baixa operacional de boleto', () => {
    const { adapter } = setup();
    expect(
      adapter.parseWebhook({ pix: [{ endToEndId: 'E00000000202610301200abc', txid: 'TX1', valor: '99.90', horario: '2026-10-30T12:00:00Z' }] }),
    ).toEqual([expect.objectContaining({ eventKey: 'pix:E00000000202610301200abc', type: 'PIX_RECEIVED', providerReference: 'TX1', amountCents: 9990 })]);
    expect(
      adapter.parseWebhook([{ id: '00031285570000000001', codigoEstadoBaixaOperacional: 1, dataLiquidacao: '30/10/2026 10:00:00', valorPagoSacado: 150.5, nomePortador: 'PII' }]),
    ).toEqual([expect.objectContaining({ type: 'BOLETO_PAID', providerReference: '00031285570000000001', amountCents: 15050 })]);
    expect(adapter.parseWebhook({ foo: 'bar' })).toEqual([]);
  });
});
