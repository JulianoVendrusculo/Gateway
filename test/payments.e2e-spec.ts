import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { formatBr } from '../src/common/utils/date-helpers';
import { PrismaService } from '../src/infra/database/prisma.service';
import { isValidDigitableLine } from '../src/modules/payments/boleto/boleto-barcode';
import { isValidBrCode } from '../src/modules/payments/pix/pix-brcode';
import { ReconciliationJob } from '../src/modules/payments/reconciliation/reconciliation.job';
import { BB_CLIENT_ID, BB_CLIENT_SECRET, BB_DEV_APP_KEY, FakeBbBank, certBase64, certFile } from './support/fake-bb-bank';

const ADMIN = { 'x-admin-token': process.env.ADMIN_API_TOKEN! };
const WEBHOOK_TOKEN = process.env.WEBHOOK_SECRET_BB!;

const customer = {
  name: 'José da Silva',
  document: '529.982.247-25',
  email: 'jose@example.com',
  address: { street: 'Rua das Flores', number: '100', neighborhood: 'Centro', city: 'Brasília', state: 'df', zipCode: '70000-000' },
};

function dueDateIn(days: number): string {
  return formatBr(new Date(Date.now() + days * 86_400_000), 'yyyy-MM-dd');
}

describe('Payment Gateway (e2e)', () => {
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const bank = new FakeBbBank();
  let merchant: { id: string; apiKey: string };
  let bbConvenioId: string;

  const auth = (key = merchant.apiKey) => ({ authorization: `Bearer ${key}` });
  const pay = (body: object, key: string, apiKey = merchant.apiKey) =>
    http.post('/v1/payments').set(auth(apiKey)).set('idempotency-key', key).send(body);

  async function createMerchant(document: string) {
    const res = await http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'Loja Exemplo Ltda', document, email: 'ops@loja.com' }).expect(201);
    return { id: res.body.merchant.id as string, apiKey: res.body.apiKey as string };
  }

  function bbConvenio(certificate: object) {
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
        urls: { oauth: `${bank.baseUrl}/oauth/token`, pix: `${bank.baseUrl}/pix/v2`, cobranca: `${bank.baseUrl}/cobrancas/v2` },
      },
      credentials: { clientId: BB_CLIENT_ID, clientSecret: BB_CLIENT_SECRET, developerAppKey: BB_DEV_APP_KEY, pixKey: 'pix@loja.com.br' },
      certificate,
    };
  }

  beforeAll(async () => {
    await bank.start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    // Banco de teste dedicado: começa limpo a cada execução.
    await prisma.$executeRaw`TRUNCATE merchants, convenios, customers, transactions, transaction_events, idempotency_keys, webhook_events CASCADE`;
  });

  afterAll(async () => {
    await app?.close();
    await bank.stop();
  });

  describe('administração de lojistas e convênios', () => {
    it('exige token administrativo', async () => {
      await http.post('/v1/admin/merchants').send({}).expect(401);
      await http.post('/v1/admin/merchants').set({ 'x-admin-token': 'errado' }).send({}).expect(401);
    });

    it('cria lojista (API key exibida uma única vez, só o HMAC é salvo)', async () => {
      merchant = await createMerchant('11.222.333/0001-81');
      expect(merchant.apiKey).toMatch(/^pgw_/);
      const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
      expect(row.apiKeyHash).not.toContain(merchant.apiKey);
      await http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'Dup', document: '11222333000181', email: 'a@b.com' }).expect(409);
    });

    it('valida CPF/CNPJ (inclusive CNPJ alfanumérico)', async () => {
      await http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'X', document: '11.222.333/0001-00', email: 'a@b.com' }).expect(400);
      await http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'Alfa', document: '12.ABC.345/01DE-35', email: 'a@b.com' }).expect(201);
    });

    it('cadastra convênio BB com certificado mTLS (PFX) e credenciais cifradas', async () => {
      const res = await http
        .post(`/v1/admin/merchants/${merchant.id}/convenios`)
        .set(ADMIN)
        .send(bbConvenio({ format: 'PFX', pfxBase64: certBase64('client.pfx'), passphrase: 'e2e-pfx-pass', caPem: certFile('ca.crt') }))
        .expect(201);
      bbConvenioId = res.body.id;
      expect(res.body.credentials).toEqual({ clientId: 'e2e-…t-id', clientSecret: '********', developerAppKey: 'e2e-…-key', pixKey: 'pix@…m.br' });
      expect(res.body.certificate.subject).toContain('Loja Teste');
      expect(JSON.stringify(res.body)).not.toContain(BB_CLIENT_SECRET);

      const row = await prisma.convenio.findUniqueOrThrow({ where: { id: bbConvenioId } });
      expect(row.credentialsCiphertext).toMatch(/^gcm1\.k1\./);
      expect(row.credentialsCiphertext).not.toContain(BB_CLIENT_SECRET);
      expect(row.certificateCiphertext).not.toContain('PRIVATE KEY');
    });

    it('rejeita URL fora da allowlist (anti-SSRF), certificado com senha errada e método não suportado', async () => {
      const evil = bbConvenio({ format: 'PEM', certPem: certFile('client.crt'), keyPem: certFile('client.key') });
      (evil.settings.urls as Record<string, string>).pix = 'https://169.254.169.254/latest';
      const ssrf = await http.post(`/v1/admin/merchants/${merchant.id}/convenios`).set(ADMIN).send(evil).expect(422);
      expect(ssrf.body.error.code).toBe('CONVENIO_INVALID');

      const badPass = await http
        .post(`/v1/admin/merchants/${merchant.id}/convenios`)
        .set(ADMIN)
        .send(bbConvenio({ format: 'PFX', pfxBase64: certBase64('client.pfx'), passphrase: 'errada' }))
        .expect(422);
      expect(badPass.body.error.details.issues[0]).toMatch(/mac verify failure/);

      const card = { ...bbConvenio({ format: 'PEM', certPem: certFile('client.crt'), keyPem: certFile('client.key') }), supportedMethods: ['CREDIT_CARD'] };
      await http.post(`/v1/admin/merchants/${merchant.id}/convenios`).set(ADMIN).send(card).expect(422);
    });
  });

  describe('PIX via Banco do Brasil (mTLS)', () => {
    let paymentId: string;
    let txid: string;
    const body = { method: 'PIX', amount: 15050, description: 'Pedido #1001', externalReference: 'order-1001', customer, pix: { expiresInSeconds: 1800 } };

    it('rejeita requisições sem API key, sem Idempotency-Key ou com campos desconhecidos', async () => {
      await http.post('/v1/payments').send(body).expect(401);
      const noKey = await http.post('/v1/payments').set(auth()).send(body).expect(400);
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const extra = await pay({ ...body, isAdmin: true }, 'pix-extra-field-1').expect(400);
      expect(extra.body.error.code).toBe('VALIDATION_ERROR');
      await pay({ ...body, amount: 10.5 }, 'pix-float-amount').expect(400);
    });

    it('cria cobrança Pix dinâmica: banco recebe certificado cliente e devolve copia-e-cola válido', async () => {
      const res = await pay(body, 'pix-order-1001').expect(201);
      paymentId = res.body.id;
      txid = res.body.pix.txid;
      expect(res.body).toMatchObject({ status: 'PENDING', method: 'PIX', provider: 'BANCO_DO_BRASIL', amount: 15050, customer: { document: '***.982.247-**' } });
      expect(txid).toMatch(/^[a-f0-9]{32}$/);
      expect(isValidBrCode(res.body.pix.copyPaste)).toBe(true);
      expect(res.body.pix.qrCodeImage).toMatch(/^data:image\/png;base64,/);
      expect(bank.clientSubjects).toContain('Loja Teste:11222333000181');
      expect(bank.requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ valor: { original: '150.50' }, devedor: { cpf: '52998224725', nome: 'José da Silva' } });
    });

    it('idempotência: mesma chave+payload devolve a mesma resposta; payload diferente é recusado', async () => {
      const replay = await pay(body, 'pix-order-1001').expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(paymentId);
      expect(await prisma.transaction.count({ where: { idempotencyKey: 'pix-order-1001' } })).toBe(1);

      const reused = await pay({ ...body, amount: 999 }, 'pix-order-1001').expect(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('requisições concorrentes com a mesma chave criam UMA única transação', async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() => pay({ ...body, externalReference: 'race' }, 'pix-race-key-1')));
      const created = results.filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.transaction.count({ where: { idempotencyKey: 'pix-race-key-1' } })).toBe(1);
    });

    it('webhook exige autenticação', async () => {
      await http.post('/v1/webhooks/bb/pix').send({ pix: [] }).expect(401);
      await http.post('/v1/webhooks/bb/pix?token=errado').send({ pix: [] }).expect(401);
    });

    it('webhook NÃO é fonte da verdade: payload forjado não marca como pago sem confirmação do banco', async () => {
      const forged = { pix: [{ endToEndId: 'E-FORJADO-0001', txid, valor: '150.50', horario: new Date().toISOString() }] };
      await http.post(`/v1/webhooks/bb/pix?token=${WEBHOOK_TOKEN}`).send(forged).expect(200);
      const res = await http.get(`/v1/payments/${paymentId}`).set(auth()).expect(200);
      expect(res.body.status).toBe('PENDING');
    });

    it('webhook do Pix + confirmação no banco => PAID; reentrega é deduplicada', async () => {
      bank.payPix(txid);
      const payload = { pix: [{ endToEndId: 'E0000000020261030ABCDEF123456', txid, valor: '150.50', horario: new Date().toISOString() }] };
      const first = await http.post(`/v1/webhooks/bb/t/${WEBHOOK_TOKEN}/pix`).send(payload).expect(200);
      expect(first.body).toMatchObject({ received: 1, processed: 1 });
      const again = await http.post(`/v1/webhooks/bb/pix`).set('x-webhook-token', WEBHOOK_TOKEN).send(payload).expect(200);
      expect(again.body).toMatchObject({ received: 1, duplicated: 1 });

      const res = await http.get(`/v1/payments/${paymentId}`).set(auth()).expect(200);
      expect(res.body).toMatchObject({ status: 'PAID', paidAmount: 15050 });
      expect(res.body.pix.qrCodeImage).toBeUndefined();
      const events = await prisma.transactionEvent.findMany({ where: { transactionId: paymentId }, orderBy: { createdAt: 'asc' } });
      expect(events.map((e) => e.toStatus)).toEqual(['PROCESSING', 'PENDING', 'PAID']);
    });

    it('recusa do banco => 422 BANK_REJECTED com transactionId e transação FAILED', async () => {
      const res = await pay({ ...body, amount: 666 }, 'pix-rejected-1').expect(422);
      expect(res.body.error).toMatchObject({ code: 'BANK_REJECTED', details: { provider: 'BANCO_DO_BRASIL' } });
      expect(res.body.error.details.bankMessage).toContain('chave não pertence ao recebedor');
      const tx = await http.get(`/v1/payments/${res.body.error.transactionId}`).set(auth()).expect(200);
      expect(tx.body.status).toBe('FAILED');
      expect(tx.body.failure.code).toMatch(/^BANK_REJECTED/);
    });

    it('outro lojista não enxerga a transação (sem IDOR)', async () => {
      const other = await createMerchant('11.444.777/0001-61');
      await http.get(`/v1/payments/${paymentId}`).set(auth(other.apiKey)).expect(404);
    });
  });

  describe('Boleto via Banco do Brasil', () => {
    const body = {
      method: 'BOLETO',
      amount: 25990,
      description: 'Mensalidade',
      customer,
      boleto: { dueDate: dueDateIn(5), instructions: ['Não receber após 30 dias'], finePercent: 2, interestMonthlyPercent: 1 },
    };

    it('valida regras de negócio antes de qualquer efeito colateral', async () => {
      const noAddress = await pay({ ...body, customer: { ...customer, address: undefined } }, 'boleto-no-address').expect(400);
      expect(noAddress.body.error.message).toContain('address');
      await pay({ ...body, boleto: { ...body.boleto, dueDate: '2020-01-01' } }, 'boleto-past-due').expect(400);
      await pay({ ...body, boleto: { ...body.boleto, finePercent: 10 } }, 'boleto-fine-cdc').expect(400);
      await pay({ ...body, pix: {} }, 'boleto-with-pix-opts').expect(400);
      expect(await prisma.transaction.count({ where: { method: 'BOLETO' } })).toBe(0);
    });

    it('registra boleto, retorna linha digitável válida e gera PDF', async () => {
      const res = await pay(body, 'boleto-0001').expect(201);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.boleto.nossoNumero).toBe('00031285570000000001');
      expect(isValidDigitableLine(res.body.boleto.digitableLine)).toBe(true);
      const sent = bank.requests.find((r) => r.path === '/cobrancas/v2/boletos')!.body as Record<string, any>;
      expect(sent).toMatchObject({ valorOriginal: 259.9, multa: { tipo: 2, porcentagem: 2 }, pagador: { nome: 'JOSE DA SILVA', uf: 'DF' } });

      const pdf = await http.get(res.body.boleto.pdfUrl).set(auth()).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      bank.liquidateBoleto(res.body.boleto.nossoNumero);
      const webhook = [{ id: res.body.boleto.nossoNumero, numeroConvenio: 3128557, codigoEstadoBaixaOperacional: 1, dataLiquidacao: '30/10/2026 10:00:00', valorPagoSacado: 259.9 }];
      await http.post(`/v1/webhooks/bb?token=${WEBHOOK_TOKEN}`).send(webhook).expect(200);
      const paid = await http.get(`/v1/payments/${res.body.id}`).set(auth()).expect(200);
      expect(paid.body).toMatchObject({ status: 'PAID', paidAmount: 25990 });
    });

    it('resultado incerto (banco registrou mas respondeu 503) => PROCESSING; reconciliação recupera a cobrança', async () => {
      const res = await pay({ ...body, amount: 777 }, 'boleto-uncertain').expect(503);
      expect(res.body.error.code).toBe('BANK_UNAVAILABLE');
      const id = res.body.error.transactionId;

      const replay = await pay({ ...body, amount: 777 }, 'boleto-uncertain').expect(503);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((await http.get(`/v1/payments/${id}`).set(auth())).body.status).toBe('PROCESSING');

      const stats = await app.get(ReconciliationJob).run();
      expect(stats.changed).toBeGreaterThanOrEqual(1);
      const recovered = await http.get(`/v1/payments/${id}`).set(auth()).expect(200);
      expect(recovered.body.status).toBe('PENDING');
      expect(isValidDigitableLine(recovered.body.boleto.digitableLine)).toBe(true);
    });
  });

  describe('mTLS negativo', () => {
    it('certificado cliente não confiável: o banco recusa no handshake e a transação fica FAILED (não processada)', async () => {
      const rogue = await createMerchant('34.028.316/0001-03');
      await http
        .post(`/v1/admin/merchants/${rogue.id}/convenios`)
        .set(ADMIN)
        .send(bbConvenio({ format: 'PEM', certPem: certFile('rogue.crt'), keyPem: certFile('rogue.key'), caPem: certFile('ca.crt') }))
        .expect(201);
      const requestsBefore = bank.requests.length;
      const res = await pay({ method: 'PIX', amount: 1000, customer }, 'rogue-pix-1', rogue.apiKey);
      // TLS 1.2: alerta no handshake (BANK_TLS_ERROR); TLS 1.3: conexão encerrada sem resposta (BANK_UNAVAILABLE).
      expect(['BANK_TLS_ERROR', 'BANK_UNAVAILABLE']).toContain(res.body.error.code);
      expect(bank.requests.length).toBe(requestsBefore); // nenhuma requisição HTTP chegou ao banco
      const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: res.body.error.transactionId } });
      expect(tx.status).toBe('FAILED');
    });
  });

  describe('Cartão de crédito (adquirente mock + tokenização)', () => {
    let cardMerchant: { id: string; apiKey: string };

    beforeAll(async () => {
      cardMerchant = await createMerchant('60.701.190/0001-04');
      await http
        .post(`/v1/admin/merchants/${cardMerchant.id}/convenios`)
        .set(ADMIN)
        .send({ provider: 'MOCK_ACQUIRER', environment: 'SANDBOX', label: 'Mock', supportedMethods: ['CREDIT_CARD'], settings: {}, credentials: { acquirerToken: 'mock-acquirer-token-123' } })
        .expect(201);
    });

    const tokenize = (number: string) =>
      http.post('/v1/cards/tokens').set(auth(cardMerchant.apiKey)).send({ number, holderName: 'Maria Silva', expMonth: 12, expYear: 2031, cvv: '123' });

    it('tokeniza (Luhn validado) e cobra apenas com token', async () => {
      await tokenize('4111111111111112').expect(400);
      const tok = await tokenize('4111111111111111').expect(201);
      expect(tok.body).toMatchObject({ brand: 'VISA', last4: '1111' });
      const res = await pay({ method: 'CREDIT_CARD', amount: 9900, customer, card: { token: tok.body.token, installments: 3 } }, 'card-0001', cardMerchant.apiKey).expect(201);
      expect(res.body).toMatchObject({ status: 'PAID', card: { brand: 'VISA', last4: '1111', installments: 3 } });
      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(JSON.stringify(row)).not.toContain('4111111111111111');
    });

    it('cartão recusado é um resultado (201 + FAILED), não um erro', async () => {
      const tok = await tokenize('4000000000000002').expect(201);
      const res = await pay({ method: 'CREDIT_CARD', amount: 100, customer, card: { token: tok.body.token } }, 'card-declined-1', cardMerchant.apiKey).expect(201);
      expect(res.body).toMatchObject({ status: 'FAILED', failure: { code: 'CARD_DECLINED' } });
    });
  });

  describe('dados em repouso', () => {
    it('nenhum segredo/PII em claro nas tabelas', async () => {
      const dump = JSON.stringify(
        await Promise.all([prisma.convenio.findMany(), prisma.customer.findMany(), prisma.idempotencyKey.findMany(), prisma.webhookEvent.findMany()]),
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      );
      expect(await prisma.convenio.count()).toBeGreaterThan(0);
      expect(await prisma.customer.count()).toBeGreaterThan(0);
      for (const secret of [BB_CLIENT_SECRET, BB_DEV_APP_KEY, '52998224725', 'jose@example.com', 'Rua das Flores', 'e2e-pfx-pass']) {
        expect(dump).not.toContain(secret);
      }
    });
  });
});
