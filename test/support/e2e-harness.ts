import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { formatBr } from '../../src/common/utils/date-helpers';
import { PrismaService } from '../../src/infra/database/prisma.service';
import { MockAcquirerAdapter } from '../../src/modules/payments/gateways/card/mock-acquirer.adapter';
import { ReconciliationJob } from '../../src/modules/payments/reconciliation/reconciliation.job';
import { BB_CLIENT_ID, BB_CLIENT_SECRET, BB_DEV_APP_KEY, FakeBbBank, certBase64, certFile } from './fake-bb-bank';

export const ADMIN = { 'x-admin-token': process.env.ADMIN_API_TOKEN! };
export const WEBHOOK_TOKEN_BB = process.env.WEBHOOK_SECRET_BB!;
export const WEBHOOK_TOKEN_MOCK = process.env.WEBHOOK_SECRET_MOCK_ACQUIRER!;

export const customer = {
  name: 'José da Silva',
  document: '529.982.247-25',
  email: 'jose@example.com',
  address: { street: 'Rua das Flores', number: '100', neighborhood: 'Centro', city: 'Brasília', state: 'df', zipCode: '70000-000' },
};

export function dueDateIn(days: number): string {
  return formatBr(new Date(Date.now() + days * 86_400_000), 'yyyy-MM-dd');
}

export interface Merchant {
  id: string;
  apiKey: string;
}

/** Sobe a aplicação real (Postgres + banco falso com mTLS) e oferece atalhos para os cenários. */
export class Harness {
  app!: NestExpressApplication;
  http!: ReturnType<typeof request>;
  prisma!: PrismaService;
  readonly bank = new FakeBbBank();

  async start(): Promise<void> {
    await this.bank.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    this.app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(this.app);
    await this.app.init();
    this.http = request(this.app.getHttpServer());
    this.prisma = this.app.get(PrismaService);
    // Banco de teste dedicado: começa limpo a cada execução.
    await this.prisma.$executeRaw`TRUNCATE merchants, convenios, customers, charges, transactions, transaction_events, refunds, idempotency_keys, webhook_events CASCADE`;
  }

  async stop(): Promise<void> {
    await this.app?.close();
    await this.bank.stop();
  }

  get job(): ReconciliationJob {
    return this.app.get(ReconciliationJob);
  }

  get mock(): MockAcquirerAdapter {
    return this.app.get(MockAcquirerAdapter);
  }

  auth(merchant: Merchant) {
    return { authorization: `Bearer ${merchant.apiKey}` };
  }

  async createMerchant(document: string): Promise<Merchant> {
    const res = await this.http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'Loja Exemplo Ltda', document, email: 'ops@loja.com' }).expect(201);
    return { id: res.body.merchant.id as string, apiKey: res.body.apiKey as string };
  }

  bbConvenio(certificate: object) {
    const base = this.bank.baseUrl;
    return {
      provider: 'BANCO_DO_BRASIL',
      environment: 'SANDBOX',
      label: 'BB principal',
      supportedMethods: ['PIX', 'BOLETO'],
      priority: 10,
      settings: {
        numeroConvenio: 3128557,
        numeroCarteira: 17,
        numeroVariacaoCarteira: 35,
        agencia: '1234',
        pixMerchantName: 'Loja Exemplo',
        pixMerchantCity: 'Brasilia',
        urls: { oauth: `${base}/oauth/token`, pix: `${base}/pix/v2`, cobranca: `${base}/cobrancas/v2` },
      },
      credentials: { clientId: BB_CLIENT_ID, clientSecret: BB_CLIENT_SECRET, developerAppKey: BB_DEV_APP_KEY, pixKey: 'pix@loja.com.br' },
      certificate,
    };
  }

  /** Convênio BB (Pix e boleto) com certificado válido. Cada lojista usa uma faixa própria de nosso número. */
  async addBbConvenio(merchant: Merchant, nossoNumeroStart = 0): Promise<string> {
    const body = { ...this.bbConvenio({ format: 'PFX', pfxBase64: certBase64('client.pfx'), passphrase: 'e2e-pfx-pass', caPem: certFile('ca.crt') }), nossoNumeroStart };
    return (await this.http.post(`/v1/admin/merchants/${merchant.id}/convenios`).set(ADMIN).send(body).expect(201)).body.id as string;
  }

  /** Convênio do provedor simulado de link de cartão. */
  async addCardConvenio(merchant: Merchant): Promise<string> {
    const body = { provider: 'MOCK_ACQUIRER', environment: 'SANDBOX', label: 'Link de cartão (simulado)', supportedMethods: ['CREDIT_CARD'], settings: {}, credentials: { acquirerToken: 'mock-acquirer-token-123' } };
    return (await this.http.post(`/v1/admin/merchants/${merchant.id}/convenios`).set(ADMIN).send(body).expect(201)).body.id as string;
  }

  /** Muda o comportamento do provedor simulado (ex.: { cancelBehavior: 'UNSUPPORTED' }). */
  async configureCardProvider(convenioId: string, settings: Record<string, unknown>): Promise<void> {
    await this.http.patch(`/v1/admin/convenios/${convenioId}`).set(ADMIN).send({ settings }).expect(200);
  }

  private keySequence = 0;

  /** POST /v1/payments. Sem `key`, cada chamada usa uma Idempotency-Key nova (um novo clique do usuário). */
  pay(merchant: Merchant, body: object, key?: string) {
    return this.http.post('/v1/payments').set(this.auth(merchant)).set('idempotency-key', key ?? `e2e-key-${Date.now()}-${++this.keySequence}`).send(body);
  }

  pix(merchant: Merchant, externalReference: string, amount = 15050, key?: string) {
    return this.pay(merchant, { method: 'PIX', amount, externalReference, customer, pix: { expiresInSeconds: 1800 } }, key);
  }

  boleto(merchant: Merchant, externalReference: string, amount = 15050, key?: string) {
    return this.pay(merchant, { method: 'BOLETO', amount, externalReference, customer, boleto: { dueDate: dueDateIn(5) } }, key);
  }

  card(merchant: Merchant, externalReference: string, amount = 15050, key?: string) {
    return this.pay(merchant, { method: 'CREDIT_CARD', amount, externalReference, customer }, key);
  }

  async charge(merchant: Merchant, externalReference: string) {
    return (await this.http.get(`/v1/charges/${externalReference}`).set(this.auth(merchant)).expect(200)).body;
  }

  async payment(merchant: Merchant, id: string) {
    return (await this.http.get(`/v1/payments/${id}`).set(this.auth(merchant)).expect(200)).body;
  }

  pixWebhook(txid: string, endToEndId: string, valor = '150.50') {
    return this.http.post(`/v1/webhooks/bb/pix?token=${WEBHOOK_TOKEN_BB}`).send({ pix: [{ endToEndId, txid, valor, horario: new Date().toISOString() }] });
  }

  boletoWebhook(nossoNumero: string, dataLiquidacao: string, valorPagoSacado = 150.5) {
    return this.http.post(`/v1/webhooks/bb?token=${WEBHOOK_TOKEN_BB}`).send([{ id: nossoNumero, numeroConvenio: 3128557, codigoEstadoBaixaOperacional: 1, dataLiquidacao, valorPagoSacado }]);
  }

  cardWebhook(payload: object) {
    return this.http.post(`/v1/webhooks/mock-acquirer?token=${WEBHOOK_TOKEN_MOCK}`).send(payload);
  }

  /** Antecipa o vencimento de uma tentativa no nosso lado (os testes não esperam o relógio). */
  async expireAttempt(id: string): Promise<void> {
    await this.prisma.transaction.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  }

  statusesOf(externalReference: string): Promise<string[]> {
    return this.prisma.transaction
      .findMany({ where: { charge: { externalReference } }, orderBy: { createdAt: 'asc' }, select: { status: true } })
      .then((rows) => rows.map((r) => r.status));
  }
}
