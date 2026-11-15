import { randomUUID } from 'node:crypto';
import { isValidDigitableLine } from '../src/modules/payments/boleto/boleto-barcode';
import { isValidBrCode } from '../src/modules/payments/pix/pix-brcode';
import { ADMIN, Harness, Merchant, WEBHOOK_TOKEN_BB, customer, dueDateIn } from './support/e2e-harness';
import { BB_CLIENT_SECRET, BB_DEV_APP_KEY, certBase64, certFile } from './support/fake-bb-bank';

/**
 * Infraestrutura herdada da v1, exercitada com o fluxo da v2: administração, mTLS com o banco,
 * idempotência, webhooks autenticados, resultado incerto, reconciliação e dados em repouso.
 * Os cenários de cobrança única estão em charges.e2e-spec.ts.
 */
describe('Payment Gateway (e2e)', () => {
  const h = new Harness();
  let merchant: Merchant;
  let bbConvenioId: string;

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  describe('administração de lojistas e convênios', () => {
    it('exige token administrativo', async () => {
      await h.http.post('/v1/admin/merchants').send({}).expect(401);
      await h.http.post('/v1/admin/merchants').set({ 'x-admin-token': 'errado' }).send({}).expect(401);
    });

    it('cria lojista (API key exibida uma única vez, só o HMAC é salvo)', async () => {
      merchant = await h.createMerchant('11.222.333/0001-81');
      expect(merchant.apiKey).toMatch(/^pgw_/);
      const row = await h.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
      expect(row.apiKeyHash).not.toContain(merchant.apiKey);
      await h.http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'Dup', document: '11222333000181', email: 'a@b.com' }).expect(409);
    });

    it('valida CPF/CNPJ (inclusive CNPJ alfanumérico)', async () => {
      await h.http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'X', document: '11.222.333/0001-00', email: 'a@b.com' }).expect(400);
      await h.http.post('/v1/admin/merchants').set(ADMIN).send({ name: 'Alfa', document: '12.ABC.345/01DE-35', email: 'a@b.com' }).expect(201);
    });

    it('cadastra convênio BB com certificado mTLS (PFX) e credenciais cifradas', async () => {
      const res = await h.http
        .post(`/v1/admin/merchants/${merchant.id}/convenios`)
        .set(ADMIN)
        .send(h.bbConvenio({ format: 'PFX', pfxBase64: certBase64('client.pfx'), passphrase: 'e2e-pfx-pass', caPem: certFile('ca.crt') }))
        .expect(201);
      bbConvenioId = res.body.id;
      expect(res.body.credentials).toEqual({ clientId: 'e2e-…t-id', clientSecret: '********', developerAppKey: 'e2e-…-key', pixKey: 'pix@…m.br' });
      expect(res.body.certificate.subject).toContain('Loja Teste');
      expect(JSON.stringify(res.body)).not.toContain(BB_CLIENT_SECRET);

      const row = await h.prisma.convenio.findUniqueOrThrow({ where: { id: bbConvenioId } });
      expect(row.credentialsCiphertext).toMatch(/^gcm1\.k1\./);
      expect(row.credentialsCiphertext).not.toContain(BB_CLIENT_SECRET);
      expect(row.certificateCiphertext).not.toContain('PRIVATE KEY');
    });

    it('rejeita URL fora da allowlist (anti-SSRF), certificado com senha errada e método não suportado', async () => {
      const evil = h.bbConvenio({ format: 'PEM', certPem: certFile('client.crt'), keyPem: certFile('client.key') });
      (evil.settings.urls as Record<string, string>).pix = 'https://169.254.169.254/latest';
      const ssrf = await h.http.post(`/v1/admin/merchants/${merchant.id}/convenios`).set(ADMIN).send(evil).expect(422);
      expect(ssrf.body.error.code).toBe('CONVENIO_INVALID');

      const badPass = await h.http
        .post(`/v1/admin/merchants/${merchant.id}/convenios`)
        .set(ADMIN)
        .send(h.bbConvenio({ format: 'PFX', pfxBase64: certBase64('client.pfx'), passphrase: 'errada' }))
        .expect(422);
      expect(badPass.body.error.details.issues[0]).toMatch(/mac verify failure/);

      const card = { ...h.bbConvenio({ format: 'PEM', certPem: certFile('client.crt'), keyPem: certFile('client.key') }), supportedMethods: ['CREDIT_CARD'] };
      await h.http.post(`/v1/admin/merchants/${merchant.id}/convenios`).set(ADMIN).send(card).expect(422);
    });
  });

  describe('PIX via Banco do Brasil (mTLS)', () => {
    let paymentId: string;
    let txid: string;
    const body = { method: 'PIX', amount: 15050, description: 'Pedido #1001', externalReference: 'order-1001', customer, pix: { expiresInSeconds: 1800 } };

    it('rejeita requisições sem API key, sem Idempotency-Key ou com campos desconhecidos', async () => {
      await h.http.post('/v1/payments').send(body).expect(401);
      const noKey = await h.http.post('/v1/payments').set(h.auth(merchant)).send(body).expect(400);
      expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const extra = await h.pay(merchant, { ...body, isAdmin: true }).expect(400);
      expect(extra.body.error.code).toBe('VALIDATION_ERROR');
      await h.pay(merchant, { ...body, amount: 10.5 }).expect(400);
      // O endpoint que recebia o número do cartão não existe na v2.
      await h.http.post('/v1/cards/tokens').set(h.auth(merchant)).send({ number: '4111111111111111' }).expect(404);
      expect(await h.prisma.charge.count()).toBe(0);
    });

    it('cria cobrança Pix dinâmica: banco recebe certificado cliente e devolve copia-e-cola válido', async () => {
      const res = await h.pay(merchant, body, 'pix-order-1001').expect(201);
      paymentId = res.body.id;
      txid = res.body.pix.txid;
      expect(res.body).toMatchObject({ status: 'PENDENTE', method: 'PIX', provider: 'BANCO_DO_BRASIL', amount: 15050, externalReference: 'order-1001', customer: { document: '***.982.247-**' } });
      expect(txid).toMatch(/^[a-f0-9]{32}$/);
      expect(isValidBrCode(res.body.pix.copyPaste)).toBe(true);
      expect(res.body.pix.qrCodeImage).toMatch(/^data:image\/png;base64,/);
      expect(h.bank.clientSubjects).toContain('Loja Teste:11222333000181');
      expect(h.bank.requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ valor: { original: '150.50' }, devedor: { cpf: '52998224725', nome: 'José da Silva' } });
    });

    it('idempotência: mesma chave+payload devolve a mesma resposta; payload diferente é recusado', async () => {
      const replay = await h.pay(merchant, body, 'pix-order-1001').expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(paymentId);
      expect(await h.prisma.transaction.count({ where: { idempotencyKey: 'pix-order-1001' } })).toBe(1);

      const reused = await h.pay(merchant, { ...body, description: 'outro pedido' }, 'pix-order-1001').expect(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('requisições concorrentes com a mesma chave criam UMA única transação', async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() => h.pay(merchant, { ...body, externalReference: 'order-race' }, 'pix-race-key-1')));
      const created = results.filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
      expect(await h.prisma.transaction.count({ where: { idempotencyKey: 'pix-race-key-1' } })).toBe(1);
    });

    it('webhook exige autenticação', async () => {
      await h.http.post('/v1/webhooks/bb/pix').send({ pix: [] }).expect(401);
      await h.http.post('/v1/webhooks/bb/pix?token=errado').send({ pix: [] }).expect(401);
    });

    it('webhook NÃO é fonte da verdade: payload forjado não marca como pago sem confirmação do banco', async () => {
      await h.pixWebhook(txid, 'E-FORJADO-0001').expect(200);
      expect((await h.payment(merchant, paymentId)).status).toBe('PENDENTE');
      expect((await h.charge(merchant, 'order-1001')).status).toBe('ABERTA');
    });

    it('webhook do Pix + confirmação no banco => CONFIRMADA; reentrega é deduplicada', async () => {
      h.bank.payPix(txid);
      const payload = { pix: [{ endToEndId: 'E0000000020261030ABCDEF123456', txid, valor: '150.50', horario: new Date().toISOString() }] };
      const first = await h.http.post(`/v1/webhooks/bb/t/${WEBHOOK_TOKEN_BB}/pix`).send(payload).expect(200);
      expect(first.body).toMatchObject({ received: 1, processed: 1 });
      const again = await h.http.post('/v1/webhooks/bb/pix').set('x-webhook-token', WEBHOOK_TOKEN_BB).send(payload).expect(200);
      expect(again.body).toMatchObject({ received: 1, duplicated: 1 });

      const paid = await h.payment(merchant, paymentId);
      expect(paid).toMatchObject({ status: 'CONFIRMADA', paidAmount: 15050 });
      expect(paid.pix.qrCodeImage).toBeUndefined();
      const events = await h.prisma.transactionEvent.findMany({ where: { transactionId: paymentId }, orderBy: { createdAt: 'asc' } });
      expect(events.map((e) => e.toStatus)).toEqual(['PROCESSANDO', 'PENDENTE', 'CONFIRMADA']);
    });

    it('recusa do banco => 422 BANK_REJECTED, tentativa FALHOU e a cobrança fica livre para outra tentativa', async () => {
      const rejected = { ...body, amount: 666, externalReference: 'order-rejected' };
      const res = await h.pay(merchant, rejected).expect(422);
      expect(res.body.error).toMatchObject({ code: 'BANK_REJECTED', details: { provider: 'BANCO_DO_BRASIL' } });
      expect(res.body.error.details.bankMessage).toContain('chave não pertence ao recebedor');
      const failed = await h.payment(merchant, res.body.error.transactionId);
      expect(failed.status).toBe('FALHOU');
      expect(failed.failure.code).toMatch(/^BANK_REJECTED/);

      expect(await h.charge(merchant, 'order-rejected')).toMatchObject({ status: 'ABERTA', awaitingConfirmation: false });
      await h.pay(merchant, { method: 'BOLETO', amount: 666, externalReference: 'order-rejected', customer, boleto: { dueDate: dueDateIn(5) } }).expect(201);
    });

    it('reconciliação que alcança uma cobrança ainda em criação não derruba a resposta nem perde o copia-e-cola', async () => {
      const cobsBefore = h.bank.cobs.size;
      h.bank.cobResponseDelayMs = 500;
      try {
        // O banco registra a cobrança na hora, mas a resposta demora: a tentativa segue PROCESSANDO nesse intervalo.
        const creating = h.pay(merchant, { ...body, amount: 4321, externalReference: 'order-sync-race' }).then((r) => r);
        while (h.bank.cobs.size === cobsBefore) await new Promise((resolve) => setTimeout(resolve, 10));
        const stats = await h.job.run();
        expect(stats.changed).toBeGreaterThanOrEqual(1); // a reconciliação chegou primeiro: PROCESSANDO -> PENDENTE

        const res = await creating;
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('PENDENTE');
        expect(isValidBrCode(res.body.pix.copyPaste)).toBe(true);
        const events = await h.prisma.transactionEvent.findMany({ where: { transactionId: res.body.id }, orderBy: { createdAt: 'asc' } });
        expect(events.map((e) => e.type)).toEqual(['payment.created', 'charge.registered', 'charge.registered']);
        expect(events[2].data).toMatchObject({ statusKept: true });
      } finally {
        h.bank.cobResponseDelayMs = 0;
      }
    });

    it('outro lojista não enxerga a transação (sem IDOR)', async () => {
      const other = await h.createMerchant('11.444.777/0001-61');
      await h.http.get(`/v1/payments/${paymentId}`).set(h.auth(other)).expect(404);
    });
  });

  describe('Boleto via Banco do Brasil', () => {
    const body = {
      method: 'BOLETO',
      amount: 25990,
      description: 'Mensalidade',
      externalReference: 'boleto-0001',
      customer,
      boleto: { dueDate: dueDateIn(5), instructions: ['Não receber após 30 dias'], finePercent: 2, interestMonthlyPercent: 1 },
    };

    it('valida regras de negócio antes de qualquer efeito colateral', async () => {
      const invalid = { ...body, externalReference: 'boleto-invalido' };
      const noAddress = await h.pay(merchant, { ...invalid, customer: { ...customer, address: undefined } }).expect(400);
      expect(noAddress.body.error.message).toContain('address');
      await h.pay(merchant, { ...invalid, boleto: { ...body.boleto, dueDate: '2020-01-01' } }).expect(400);
      await h.pay(merchant, { ...invalid, boleto: { ...body.boleto, dueDate: '2030-02-30' } }).expect(400);
      await h.pay(merchant, { ...invalid, boleto: { ...body.boleto, finePercent: 10 } }).expect(400);
      await h.pay(merchant, { ...invalid, pix: {} }).expect(400);
      expect(await h.prisma.charge.count({ where: { externalReference: 'boleto-invalido' } })).toBe(0);
    });

    it('registra boleto, retorna linha digitável válida e gera PDF', async () => {
      const boletosBefore = h.bank.requests.filter((r) => r.path === '/cobrancas/v2/boletos').length;
      const res = await h.pay(merchant, body).expect(201);
      expect(res.body.status).toBe('PENDENTE');
      expect(isValidDigitableLine(res.body.boleto.digitableLine)).toBe(true);
      // O boleto é uma tentativa ativa até o fim do dia do vencimento, no horário de Brasília.
      expect(res.body.expiresAt).toBe(`${dueDateIn(6)}T02:59:59.999Z`);
      const sent = h.bank.requests.filter((r) => r.path === '/cobrancas/v2/boletos')[boletosBefore].body as Record<string, any>;
      expect(sent).toMatchObject({ valorOriginal: 259.9, multa: { tipo: 2, porcentagem: 2 }, pagador: { nome: 'JOSE DA SILVA', uf: 'DF' } });

      const pdf = await h.http.get(res.body.boleto.pdfUrl).set(h.auth(merchant)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      h.bank.liquidateBoleto(res.body.boleto.nossoNumero);
      await h.boletoWebhook(res.body.boleto.nossoNumero, '30/10/2026 10:00:00', 259.9).expect(200);
      expect(await h.payment(merchant, res.body.id)).toMatchObject({ status: 'CONFIRMADA', paidAmount: 25990 });
    });

    it('resultado incerto (banco registrou mas respondeu 503): PROCESSANDO bloqueia a cobrança até a reconciliação recuperar o boleto', async () => {
      const uncertain = { ...body, amount: 777, externalReference: 'boleto-incerto' };
      const res = await h.pay(merchant, uncertain, 'boleto-uncertain').expect(503);
      expect(res.body.error.code).toBe('BANK_UNAVAILABLE');
      const id = res.body.error.transactionId;

      const replay = await h.pay(merchant, uncertain, 'boleto-uncertain').expect(503);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((await h.payment(merchant, id)).status).toBe('PROCESSANDO');

      // Não se sabe se o boleto existe no banco: nenhuma outra tentativa pode ser criada para esta inscrição.
      const blocked = await h.pay(merchant, { method: 'PIX', amount: 777, externalReference: 'boleto-incerto', customer }).expect(409);
      expect(blocked.body.error).toMatchObject({ code: 'TENTATIVA_EM_ANDAMENTO', details: { status: 'PROCESSANDO', transactionId: id } });

      const stats = await h.job.run();
      expect(stats.changed).toBeGreaterThanOrEqual(1);
      const recovered = await h.payment(merchant, id);
      expect(recovered.status).toBe('PENDENTE');
      expect(isValidDigitableLine(recovered.boleto.digitableLine)).toBe(true);
    });
  });

  describe('mTLS negativo', () => {
    it('certificado cliente não confiável: o banco recusa no handshake e a tentativa fica FALHOU (não processada)', async () => {
      const rogue = await h.createMerchant('34.028.316/0001-03');
      await h.http
        .post(`/v1/admin/merchants/${rogue.id}/convenios`)
        .set(ADMIN)
        .send(h.bbConvenio({ format: 'PEM', certPem: certFile('rogue.crt'), keyPem: certFile('rogue.key'), caPem: certFile('ca.crt') }))
        .expect(201);
      const requestsBefore = h.bank.requests.length;
      const res = await h.pix(rogue, 'rogue-pix', 1000);
      // TLS 1.2: alerta no handshake (BANK_TLS_ERROR); TLS 1.3: conexão encerrada sem resposta (BANK_UNAVAILABLE).
      expect(['BANK_TLS_ERROR', 'BANK_UNAVAILABLE']).toContain(res.body.error.code);
      expect(h.bank.requests.length).toBe(requestsBefore); // nenhuma requisição HTTP chegou ao banco
      const tx = await h.prisma.transaction.findUniqueOrThrow({ where: { id: res.body.error.transactionId } });
      expect(tx.status).toBe('FALHOU');
    });

    it('servidor com certificado não confiável: o gateway recusa a conexão e nada é enviado', async () => {
      const strict = await h.createMerchant('33.000.167/0001-01');
      // Sem caPem: a CA do banco falso não está entre as raízes públicas, então a verificação do servidor tem de falhar.
      await h.http
        .post(`/v1/admin/merchants/${strict.id}/convenios`)
        .set(ADMIN)
        .send(h.bbConvenio({ format: 'PFX', pfxBase64: certBase64('client.pfx'), passphrase: 'e2e-pfx-pass' }))
        .expect(201);
      const requestsBefore = h.bank.requests.length;
      const res = await h.pix(strict, 'untrusted-server', 1000).expect(502);
      expect(res.body.error.code).toBe('BANK_TLS_ERROR');
      expect(h.bank.requests.length).toBe(requestsBefore); // nem o pedido de token saiu
      const tx = await h.prisma.transaction.findUniqueOrThrow({ where: { id: res.body.error.transactionId } });
      expect(tx.status).toBe('FALHOU');
    });
  });

  describe('reconciliação', () => {
    let cardMerchant: Merchant;
    let cardConvenioId: string;

    beforeAll(async () => {
      cardMerchant = await h.createMerchant('60.701.190/0001-04');
      cardConvenioId = await h.addCardConvenio(cardMerchant);
    });

    it('timeout ao criar o link: fica PROCESSANDO e a reconciliação encerra a tentativa que nunca foi registrada', async () => {
      await h.configureCardProvider(cardConvenioId, { createBehavior: 'TIMEOUT' });
      const res = await h.card(cardMerchant, 'card-timeout', 500).expect(504);
      expect(res.body.error.code).toBe('BANK_TIMEOUT');
      const id = res.body.error.transactionId as string;
      await h.configureCardProvider(cardConvenioId, {});

      // Dentro da carência, o provedor não conhecer a cobrança ainda não prova nada.
      await h.job.run();
      expect((await h.payment(cardMerchant, id)).status).toBe('PROCESSANDO');

      // Passada a carência, a ausência é conclusiva: a tentativa falhou e a inscrição pode tentar de novo.
      await h.prisma.transaction.update({ where: { id }, data: { createdAt: new Date(Date.now() - 16 * 60_000), lastSyncedAt: null } });
      await h.job.run();
      expect(await h.payment(cardMerchant, id)).toMatchObject({ status: 'FALHOU', failure: { code: 'NOT_REGISTERED_AT_PROVIDER' } });
      await h.card(cardMerchant, 'card-timeout', 500).expect(201);
    });

    it('itens que falham na reconciliação não travam a fila dos demais lojistas', async () => {
      // Um lojista com 60 tentativas que sempre falham ao sincronizar (mais que um lote de 50)...
      const payer = await h.prisma.customer.findFirstOrThrow({ where: { merchantId: cardMerchant.id } });
      const charges = Array.from({ length: 60 }, (_, i) => ({ id: randomUUID(), merchantId: cardMerchant.id, externalReference: `stuck-${i}`, amountCents: 100 }));
      await h.prisma.charge.createMany({ data: charges });
      await h.prisma.transaction.createMany({
        data: charges.map((charge, i) => ({
          id: randomUUID(),
          chargeId: charge.id,
          merchantId: cardMerchant.id,
          convenioId: cardConvenioId,
          customerId: payer.id,
          method: 'CREDIT_CARD' as const,
          provider: 'MOCK_ACQUIRER' as const,
          status: 'PENDENTE' as const,
          amountCents: 100,
          idempotencyKey: `stuck-${i}`,
          externalReference: charge.externalReference,
          providerReference: `lnk_${i.toString(16).padStart(32, '0')}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      });

      // ...e uma cobrança Pix de outro lojista, já paga no banco, aguardando a vez na fila.
      const pix = await h.pix(merchant, 'pix-behind-stuck-queue', 2500).expect(201);
      h.bank.payPix(pix.body.pix.txid);
      await h.prisma.transaction.update({ where: { id: pix.body.id }, data: { lastSyncedAt: new Date(Date.now() - 3_600_000) } });

      const first = await h.job.run(); // o lote inteiro é consumido pelas que falham
      expect(first.failed).toBe(50);
      await h.job.run(); // elas foram para o fim da fila: agora a Pix é alcançada
      expect((await h.payment(merchant, pix.body.id)).status).toBe('CONFIRMADA');
    });
  });

  describe('convivência com dados da v1', () => {
    it('transação criada pela v1 continua legível, e a v2 não a altera nem a concilia', async () => {
      const payer = await h.prisma.customer.findFirstOrThrow({ where: { merchantId: merchant.id } });
      const legacy = await h.prisma.transaction.create({
        data: { id: randomUUID(), merchantId: merchant.id, convenioId: bbConvenioId, customerId: payer.id, method: 'PIX', provider: 'BANCO_DO_BRASIL', status: 'PENDING', amountCents: 1234, idempotencyKey: 'legado-v1-0001', providerReference: 'a'.repeat(32) },
      });
      expect(await h.payment(merchant, legacy.id)).toMatchObject({ status: 'PENDING', chargeId: null, amount: 1234 });

      const requests = h.bank.requests.length;
      await h.http.get(`/v1/payments/${legacy.id}?refresh=true`).set(h.auth(merchant)).expect(200);
      const webhook = await h.pixWebhook(legacy.providerReference!, 'E-LEGADO-0001').expect(200);
      expect(webhook.body).toMatchObject({ ignored: 1 });
      expect(h.bank.requests.length).toBe(requests);
      expect((await h.prisma.transaction.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('PENDING');

      // O banco de dados não deixa os dois vocabulários se misturarem.
      await expect(h.prisma.transaction.update({ where: { id: legacy.id }, data: { status: 'PENDENTE' } })).rejects.toThrow(/transactions_status_matches_generation/);
      await h.prisma.transaction.delete({ where: { id: legacy.id } });
    });
  });

  describe('dados em repouso', () => {
    it('nenhum segredo/PII em claro nas tabelas', async () => {
      const dump = JSON.stringify(
        await Promise.all([h.prisma.convenio.findMany(), h.prisma.customer.findMany(), h.prisma.idempotencyKey.findMany(), h.prisma.webhookEvent.findMany(), h.prisma.charge.findMany(), h.prisma.refund.findMany()]),
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      );
      expect(await h.prisma.convenio.count()).toBeGreaterThan(0);
      expect(await h.prisma.customer.count()).toBeGreaterThan(0);
      for (const secret of [BB_CLIENT_SECRET, BB_DEV_APP_KEY, '52998224725', 'jose@example.com', 'Rua das Flores', 'e2e-pfx-pass']) {
        expect(dump).not.toContain(secret);
      }
    });
  });
});
