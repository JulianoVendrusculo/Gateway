import { randomUUID } from 'node:crypto';
import { Harness, Merchant, customer, dueDateIn } from './support/e2e-harness';

/**
 * Cobrança única (v2): uma inscrição = uma Charge; Pix, boleto e cartão são tentativas dentro dela.
 * Aplicação real + Postgres + banco falso (BB) com mTLS + provedor simulado de link de cartão.
 */
describe('Cobrança única (v2)', () => {
  const h = new Harness();
  let m: Merchant;
  let cardConvenioId: string;

  const attemptsOf = (externalReference: string) =>
    h.prisma.transaction.findMany({ where: { charge: { externalReference } }, orderBy: { createdAt: 'asc' } });
  const refundsOf = (externalReference: string) => h.prisma.refund.findMany({ where: { charge: { externalReference } } });
  const linkReference = async (id: string) => (await h.prisma.transaction.findUniqueOrThrow({ where: { id } })).providerReference!;

  beforeAll(async () => {
    await h.start();
    m = await h.createMerchant('11.222.333/0001-81');
    await h.addBbConvenio(m);
    cardConvenioId = await h.addCardConvenio(m);
  });

  afterEach(async () => {
    h.bank.cancelBehavior = 'OK';
    h.bank.cobResponseDelayMs = 0;
    await h.configureCardProvider(cardConvenioId, {});
  });

  afterAll(() => h.stop());

  describe('uma inscrição, uma cobrança', () => {
    it('exige externalReference e recusa valor diferente para a mesma inscrição', async () => {
      const missing = await h.pay(m, { method: 'PIX', amount: 15050, customer }).expect(400);
      expect(JSON.stringify(missing.body.error.details)).toContain('externalReference');

      const first = await h.pix(m, 'insc-basico').expect(201);
      expect(first.body).toMatchObject({ status: 'PENDENTE', method: 'PIX', externalReference: 'insc-basico', reused: false });
      expect(first.body.chargeId).toBeTruthy();

      const other = await h.pix(m, 'insc-basico', 9999).expect(422);
      expect(other.body.error).toMatchObject({ code: 'COBRANCA_VALOR_DIVERGENTE', details: { chargeAmount: 15050, requestedAmount: 9999 } });
    });

    it('Pix de novo com o QR Code válido devolve o MESMO QR Code, sem criar outra cobrança no banco', async () => {
      const [existing] = await attemptsOf('insc-basico');
      const cobs = h.bank.cobs.size;
      const again = await h.pix(m, 'insc-basico').expect(200);
      expect(again.body).toMatchObject({ id: existing.id, reused: true, status: 'PENDENTE' });
      expect(again.body.pix.copyPaste).toBeTruthy();
      expect(h.bank.cobs.size).toBe(cobs);
      expect(await h.statusesOf('insc-basico')).toEqual(['PENDENTE']);
    });

    it('boleto de novo com um em aberto devolve o MESMO boleto', async () => {
      const first = await h.boleto(m, 'insc-boleto').expect(201);
      const boletos = h.bank.boletos.size;
      const again = await h.boleto(m, 'insc-boleto').expect(200);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.boleto.nossoNumero).toBe(first.body.boleto.nossoNumero);
      expect(h.bank.boletos.size).toBe(boletos);
    });

    it('GET /v1/charges/:externalReference devolve a cobrança e a tentativa ativa para o front', async () => {
      const charge = await h.charge(m, 'insc-basico');
      expect(charge).toMatchObject({ externalReference: 'insc-basico', status: 'ABERTA', amount: 15050, awaitingConfirmation: true, paidTransactionId: null, pendingRefunds: [] });
      expect(charge.activeAttempt).toMatchObject({ method: 'PIX', status: 'PENDENTE' });
      expect(charge.activeAttempt.pix.qrCodeImage).toMatch(/^data:image\/png;base64,/);
      expect(charge.attempts).toHaveLength(1);

      await h.http.get('/v1/charges/inscricao-inexistente').set(h.auth(m)).expect(404);
      const outro = await h.createMerchant('11.444.777/0001-61');
      await h.http.get('/v1/charges/insc-basico').set(h.auth(outro)).expect(404);
    });

    it('o banco de dados recusa uma segunda tentativa ativa e uma segunda confirmada (índices únicos parciais)', async () => {
      const [active] = await attemptsOf('insc-basico');
      const clone = (status: 'PENDENTE' | 'EM_VERIFICACAO' | 'CONFIRMADA') =>
        h.prisma.transaction.create({
          data: { id: randomUUID(), chargeId: active.chargeId, merchantId: active.merchantId, convenioId: active.convenioId, customerId: active.customerId, method: 'BOLETO', provider: active.provider, status, amountCents: 15050, idempotencyKey: `direto-${randomUUID()}` },
        });
      await expect(clone('PENDENTE')).rejects.toMatchObject({ code: 'P2002' });
      await expect(clone('EM_VERIFICACAO')).rejects.toMatchObject({ code: 'P2002' });

      const confirmed = await clone('CONFIRMADA');
      await expect(clone('CONFIRMADA')).rejects.toMatchObject({ code: 'P2002' });
      await h.prisma.transaction.delete({ where: { id: confirmed.id } });
    });
  });

  describe('requisições simultâneas na mesma cobrança', () => {
    it('quatro pedidos de Pix ao mesmo tempo criam UMA tentativa e UMA cobrança no banco', async () => {
      const cobs = h.bank.cobs.size;
      const results = await Promise.all([1, 2, 3, 4].map(() => h.pix(m, 'insc-simultanea-1')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of results) {
        expect([200, 201, 409]).toContain(r.status);
        if (r.status === 409) expect(r.body.error.code).toBe('TENTATIVA_EM_ANDAMENTO');
      }
      expect(h.bank.cobs.size).toBe(cobs + 1);
      expect(await h.statusesOf('insc-simultanea-1')).toEqual(['PENDENTE']);
    });

    it('Pix e boleto pedidos ao mesmo tempo nunca deixam duas tentativas que possam ser pagas', async () => {
      const payable = h.bank.payableCount();
      h.bank.cobResponseDelayMs = 200;
      const results = await Promise.all([h.pix(m, 'insc-simultanea-2'), h.boleto(m, 'insc-simultanea-2')]);
      for (const r of results) {
        expect([201, 409]).toContain(r.status);
        if (r.status === 409) expect(r.body.error.code).toBe('TENTATIVA_EM_ANDAMENTO');
      }
      const attempts = await attemptsOf('insc-simultanea-2');
      expect(attempts.filter((a) => ['PENDENTE', 'PROCESSANDO', 'EM_VERIFICACAO'].includes(a.status))).toHaveLength(1);
      expect(h.bank.payableCount()).toBe(payable + 1);
    });
  });

  describe('troca de método', () => {
    it('cancelamento aceito e CONFIRMADO pelo banco: a tentativa antiga é cancelada e a nova é criada', async () => {
      const pix = await h.pix(m, 'insc-troca-aceita').expect(201);
      const boleto = await h.boleto(m, 'insc-troca-aceita').expect(201);
      expect(boleto.body).toMatchObject({ method: 'BOLETO', status: 'PENDENTE', reused: false });

      expect(h.bank.cobs.get(pix.body.pix.txid)!.status).toBe('REMOVIDA_PELO_USUARIO_RECEBEDOR');
      expect(await h.statusesOf('insc-troca-aceita')).toEqual(['CANCELADA', 'PENDENTE']);
      const events = await h.prisma.transactionEvent.findMany({ where: { transactionId: pix.body.id }, orderBy: { createdAt: 'asc' } });
      expect(events.map((e) => e.type)).toEqual(['payment.created', 'charge.registered', 'cancel.requested', 'attempt.canceled']);
      expect((await h.charge(m, 'insc-troca-aceita')).activeAttempt.id).toBe(boleto.body.id);
    });

    it('cancelamento recusado: 409 CANCELAMENTO_RECUSADO, nada novo é criado e a tentativa atual continua valendo', async () => {
      const pix = await h.pix(m, 'insc-troca-recusada').expect(201);
      const boletos = h.bank.boletos.size;
      h.bank.cancelBehavior = 'REFUSE';

      const res = await h.boleto(m, 'insc-troca-recusada').expect(409);
      expect(res.body.error).toMatchObject({ code: 'CANCELAMENTO_RECUSADO', details: { transactionId: pix.body.id, method: 'PIX' } });
      expect(h.bank.boletos.size).toBe(boletos);
      expect(h.bank.cobs.get(pix.body.pix.txid)!.status).toBe('ATIVA');

      const [attempt] = await attemptsOf('insc-troca-recusada');
      expect(attempt).toMatchObject({ status: 'PENDENTE', cancelRequestedAt: null, cancelReason: null });
      expect((await h.pix(m, 'insc-troca-recusada').expect(200)).body.id).toBe(pix.body.id);
    });

    it('falha técnica no cancelamento: erro de banco, troca bloqueada e a tentativa atual continua valendo', async () => {
      const pix = await h.pix(m, 'insc-troca-erro').expect(201);
      h.bank.cancelBehavior = 'ERROR';
      const res = await h.boleto(m, 'insc-troca-erro').expect(503);
      expect(res.body.error.code).toBe('BANK_UNAVAILABLE');

      h.bank.cancelBehavior = 'OK';
      expect(await h.statusesOf('insc-troca-erro')).toEqual(['PENDENTE']);
      expect((await h.pix(m, 'insc-troca-erro').expect(200)).body.id).toBe(pix.body.id);
    });

    it('ao cancelar, o banco informa que o Pix já foi pago: vale como confirmação e a troca vira 409 PAGAMENTO_JA_CONFIRMADO', async () => {
      const pix = await h.pix(m, 'insc-troca-ja-paga').expect(201);
      h.bank.payPix(pix.body.pix.txid); // pagou, mas o webhook ainda não chegou
      const boletos = h.bank.boletos.size;

      const res = await h.boleto(m, 'insc-troca-ja-paga').expect(409);
      expect(res.body.error).toMatchObject({ code: 'PAGAMENTO_JA_CONFIRMADO', details: { paidTransactionId: pix.body.id } });
      expect(h.bank.boletos.size).toBe(boletos);
      expect(await h.charge(m, 'insc-troca-ja-paga')).toMatchObject({ status: 'PAGA', paidTransactionId: pix.body.id, awaitingConfirmation: false, activeAttempt: null });
    });

    it('link de cartão sem API de cancelamento: a troca fica bloqueada até o link expirar, e isso é registrado como limitação', async () => {
      await h.configureCardProvider(cardConvenioId, { cancelBehavior: 'UNSUPPORTED' });
      const link = await h.card(m, 'insc-cartao-sem-cancelamento').expect(201);

      const res = await h.pix(m, 'insc-cartao-sem-cancelamento').expect(409);
      expect(res.body.error).toMatchObject({ code: 'CANCELAMENTO_RECUSADO', details: { transactionId: link.body.id, method: 'CREDIT_CARD', limitation: true, activeUntil: link.body.expiresAt } });
      const events = await h.prisma.transactionEvent.findMany({ where: { transactionId: link.body.id, type: 'cancel.unsupported' } });
      expect(events).toHaveLength(1);
      expect(await h.statusesOf('insc-cartao-sem-cancelamento')).toEqual(['PENDENTE']);
    });
  });

  describe('a primeira confirmação vence', () => {
    it('cobrança paga não aceita nova tentativa: 409 PAGAMENTO_JA_CONFIRMADO', async () => {
      const pix = await h.pix(m, 'insc-paga').expect(201);
      h.bank.payPix(pix.body.pix.txid);
      expect((await h.pixWebhook(pix.body.pix.txid, 'E-INSC-PAGA-0001').expect(200)).body).toMatchObject({ processed: 1 });

      expect(await h.payment(m, pix.body.id)).toMatchObject({ status: 'CONFIRMADA', paidAmount: 15050 });
      for (const attempt of [() => h.pix(m, 'insc-paga'), () => h.boleto(m, 'insc-paga'), () => h.card(m, 'insc-paga')]) {
        expect((await attempt().expect(409)).body.error.code).toBe('PAGAMENTO_JA_CONFIRMADO');
      }
      expect(await h.statusesOf('insc-paga')).toEqual(['CONFIRMADA']);
    });

    it('boleto compensado depois do Pix: vira PAGO_DUPLICADO e abre estorno PENDENTE_ANALISE, sem estornar nada', async () => {
      const boleto = await h.boleto(m, 'insc-boleto-depois-do-pix').expect(201);
      const pix = await h.pix(m, 'insc-boleto-depois-do-pix').expect(201); // troca: o boleto é baixado no banco
      h.bank.payPix(pix.body.pix.txid);
      await h.pixWebhook(pix.body.pix.txid, 'E-BOLETO-DEPOIS-0001').expect(200);
      expect(await h.charge(m, 'insc-boleto-depois-do-pix')).toMatchObject({ status: 'PAGA', paidTransactionId: pix.body.id });

      // O boleto tinha sido pago em outro banco antes da baixa; a liquidação chega no dia seguinte.
      h.bank.liquidateBoleto(boleto.body.boleto.nossoNumero);
      expect((await h.boletoWebhook(boleto.body.boleto.nossoNumero, '16/11/2026 09:00:00').expect(200)).body).toMatchObject({ processed: 1 });

      expect(await h.statusesOf('insc-boleto-depois-do-pix')).toEqual(['PAGO_DUPLICADO', 'CONFIRMADA']);
      const refunds = await refundsOf('insc-boleto-depois-do-pix');
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ transactionId: boleto.body.id, status: 'PENDENTE_ANALISE', reason: 'COBRANCA_JA_PAGA', amountCents: 15050 });

      const charge = await h.charge(m, 'insc-boleto-depois-do-pix');
      expect(charge).toMatchObject({ status: 'PAGA', paidTransactionId: pix.body.id });
      expect(charge.pendingRefunds).toEqual([expect.objectContaining({ transactionId: boleto.body.id, status: 'PENDENTE_ANALISE', amount: 15050 })]);
    });

    it('pagamento tardio de uma tentativa cancelada quita a cobrança e derruba no banco a tentativa que estava ativa', async () => {
      const boleto = await h.boleto(m, 'insc-pagamento-tardio').expect(201);
      const pix = await h.pix(m, 'insc-pagamento-tardio').expect(201);
      expect(await h.statusesOf('insc-pagamento-tardio')).toEqual(['CANCELADA', 'PENDENTE']);

      h.bank.liquidateBoleto(boleto.body.boleto.nossoNumero);
      await h.boletoWebhook(boleto.body.boleto.nossoNumero, '16/11/2026 09:00:00').expect(200);

      expect(await h.statusesOf('insc-pagamento-tardio')).toEqual(['CONFIRMADA', 'CANCELADA']);
      expect(await h.charge(m, 'insc-pagamento-tardio')).toMatchObject({ status: 'PAGA', paidTransactionId: boleto.body.id, activeAttempt: null });
      expect(h.bank.cobs.get(pix.body.pix.txid)!.status).toBe('REMOVIDA_PELO_USUARIO_RECEBEDOR');
      expect(await refundsOf('insc-pagamento-tardio')).toHaveLength(0);
    });

    it('dois webhooks simultâneos de tentativas diferentes: uma confirma, a outra vira PAGO_DUPLICADO', async () => {
      const boleto = await h.boleto(m, 'insc-dois-webhooks').expect(201);
      const pix = await h.pix(m, 'insc-dois-webhooks').expect(201);
      h.bank.payPix(pix.body.pix.txid);
      h.bank.liquidateBoleto(boleto.body.boleto.nossoNumero);

      const [a, b] = await Promise.all([
        h.pixWebhook(pix.body.pix.txid, 'E-DOIS-WEBHOOKS-0001'),
        h.boletoWebhook(boleto.body.boleto.nossoNumero, '16/11/2026 09:00:00'),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);

      const statuses = await h.statusesOf('insc-dois-webhooks');
      expect([...statuses].sort()).toEqual(['CONFIRMADA', 'PAGO_DUPLICADO']);
      const charge = await h.charge(m, 'insc-dois-webhooks');
      const attempts = await attemptsOf('insc-dois-webhooks');
      expect(charge.status).toBe('PAGA');
      expect(charge.paidTransactionId).toBe(attempts.find((t) => t.status === 'CONFIRMADA')!.id);
      const refunds = await refundsOf('insc-dois-webhooks');
      expect(refunds).toHaveLength(1);
      expect(refunds[0].transactionId).toBe(attempts.find((t) => t.status === 'PAGO_DUPLICADO')!.id);
    });

    it('o mesmo evento entregue duas vezes ao mesmo tempo é processado uma vez só', async () => {
      const pix = await h.pix(m, 'insc-evento-repetido').expect(201);
      h.bank.payPix(pix.body.pix.txid);
      const results = await Promise.all([1, 2, 3].map(() => h.pixWebhook(pix.body.pix.txid, 'E-EVENTO-REPETIDO-0001')));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(results.reduce((sum, r) => sum + r.body.processed, 0)).toBe(1);
      expect(results.reduce((sum, r) => sum + r.body.duplicated, 0)).toBe(2);

      expect(await h.statusesOf('insc-evento-repetido')).toEqual(['CONFIRMADA']);
      expect(await refundsOf('insc-evento-repetido')).toHaveLength(0);
      expect(await h.prisma.webhookEvent.count({ where: { eventKey: 'pix:E-EVENTO-REPETIDO-0001' } })).toBe(1);
    });

    it('duas liquidações do mesmo boleto: a segunda vira PAGO_DUPLICADO em uma linha própria', async () => {
      const boleto = await h.boleto(m, 'insc-duas-liquidacoes').expect(201);
      const nossoNumero = boleto.body.boleto.nossoNumero;
      h.bank.liquidateBoleto(nossoNumero);

      await h.boletoWebhook(nossoNumero, '16/11/2026 09:00:00').expect(200);
      expect(await h.statusesOf('insc-duas-liquidacoes')).toEqual(['CONFIRMADA']);

      await h.boletoWebhook(nossoNumero, '16/11/2026 14:30:00').expect(200);
      const reentrega = await h.boletoWebhook(nossoNumero, '16/11/2026 14:30:00').expect(200);
      expect(reentrega.body).toMatchObject({ duplicated: 1, processed: 0 });

      const attempts = await attemptsOf('insc-duas-liquidacoes');
      expect(attempts.map((t) => t.status)).toEqual(['CONFIRMADA', 'PAGO_DUPLICADO']);
      expect(attempts[1]).toMatchObject({ duplicateOfId: boleto.body.id, method: 'BOLETO', paidAmountCents: 15050 });
      const refunds = await refundsOf('insc-duas-liquidacoes');
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ transactionId: attempts[1].id, status: 'PENDENTE_ANALISE', reason: 'SEGUNDO_PAGAMENTO_DA_TENTATIVA' });
      expect((await h.charge(m, 'insc-duas-liquidacoes')).paidTransactionId).toBe(boleto.body.id);
    });
  });

  describe('cartão por link (HOSTED_LINK)', () => {
    it('o link é a tentativa ativa: nova solicitação de cartão devolve o MESMO link', async () => {
      const first = await h.card(m, 'insc-cartao-link').expect(201);
      expect(first.body).toMatchObject({ method: 'CREDIT_CARD', status: 'PENDENTE', card: { mode: 'HOSTED_LINK' } });
      expect(first.body.card.paymentUrl).toMatch(/^https:\/\/pagamento\.exemplo\.invalid\/link\/lnk_[a-f0-9]{32}$/);
      const ttl = new Date(first.body.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(890_000);
      expect(ttl).toBeLessThanOrEqual(900_000);

      const again = await h.card(m, 'insc-cartao-link').expect(200);
      expect(again.body).toMatchObject({ id: first.body.id, reused: true });
      expect(again.body.card.paymentUrl).toBe(first.body.card.paymentUrl);
      expect(await h.charge(m, 'insc-cartao-link')).toMatchObject({ awaitingConfirmation: true, activeAttempt: { id: first.body.id } });
    });

    it('a confirmação chega por webhook e quita a cobrança', async () => {
      const [link] = await attemptsOf('insc-cartao-link');
      const webhook = h.mock.simulatePayment(link.providerReference!);
      expect((await h.cardWebhook(webhook).expect(200)).body).toMatchObject({ processed: 1 });

      const paid = await h.payment(m, link.id);
      expect(paid).toMatchObject({ status: 'CONFIRMADA', paidAmount: 15050 });
      expect(paid.card.paymentUrl).toBeUndefined();
      expect(await h.charge(m, 'insc-cartao-link')).toMatchObject({ status: 'PAGA', awaitingConfirmation: false });
      await h.http.post('/v1/webhooks/mock-acquirer').send(webhook).expect(401);
    });

    it('link expirado NÃO libera a cobrança: fica EM_VERIFICACAO, e o pagamento tardio é confirmado', async () => {
      const link = await h.card(m, 'insc-cartao-tardio').expect(201);
      const reference = await linkReference(link.body.id);
      await h.expireAttempt(link.body.id);
      h.mock.simulateExpiration(reference);

      await h.job.run(); // consulta o banco: não consta pago, então começa a janela de tolerância
      const verifying = await h.payment(m, link.body.id);
      expect(verifying.status).toBe('EM_VERIFICACAO');
      const windowMs = new Date(verifying.verificationUntil).getTime() - new Date(verifying.expiresAt).getTime();
      expect(windowMs).toBe(1800_000);

      // Enquanto verifica, nenhum outro pagamento pode ser gerado, por método algum.
      for (const attempt of [() => h.card(m, 'insc-cartao-tardio'), () => h.pix(m, 'insc-cartao-tardio')]) {
        const res = await attempt().expect(409);
        expect(res.body.error).toMatchObject({ code: 'TENTATIVA_EM_ANDAMENTO', details: { status: 'EM_VERIFICACAO', until: verifying.verificationUntil } });
      }
      expect(await h.charge(m, 'insc-cartao-tardio')).toMatchObject({ status: 'ABERTA', awaitingConfirmation: true, activeAttempt: { status: 'EM_VERIFICACAO' } });

      // O pagador tinha concluído o pagamento na página do banco; a confirmação chega atrasada.
      await h.cardWebhook(h.mock.simulatePayment(reference, { force: true })).expect(200);
      expect(await h.statusesOf('insc-cartao-tardio')).toEqual(['CONFIRMADA']);
      expect(await h.charge(m, 'insc-cartao-tardio')).toMatchObject({ status: 'PAGA', paidTransactionId: link.body.id });
    });

    it('pagamento tardio sem webhook também é confirmado: o job reconsulta as tentativas EM_VERIFICACAO', async () => {
      const link = await h.card(m, 'insc-cartao-tardio-job').expect(201);
      const reference = await linkReference(link.body.id);
      await h.expireAttempt(link.body.id);
      h.mock.simulateExpiration(reference);
      await h.job.run();
      expect(await h.statusesOf('insc-cartao-tardio-job')).toEqual(['EM_VERIFICACAO']);

      h.mock.simulatePayment(reference, { force: true }); // o webhook se perdeu
      await h.prisma.transaction.update({ where: { id: link.body.id }, data: { lastSyncedAt: new Date(Date.now() - 3_600_000) } });
      await h.job.run();
      expect(await h.statusesOf('insc-cartao-tardio-job')).toEqual(['CONFIRMADA']);
    });

    it('sem pagamento, só ao fim da janela a tentativa vira EXPIRADA e a cobrança aceita outro link', async () => {
      const link = await h.card(m, 'insc-cartao-expirado').expect(201);
      const reference = await linkReference(link.body.id);
      await h.expireAttempt(link.body.id);
      h.mock.simulateExpiration(reference);
      await h.job.run();
      await h.job.run(); // dentro da janela nada muda
      expect(await h.statusesOf('insc-cartao-expirado')).toEqual(['EM_VERIFICACAO']);

      await h.prisma.transaction.update({ where: { id: link.body.id }, data: { verificationUntil: new Date(Date.now() - 1000) } });
      await h.job.run(); // fim da janela: consulta de novo e só então libera
      expect(await h.statusesOf('insc-cartao-expirado')).toEqual(['EXPIRADA']);

      const novo = await h.card(m, 'insc-cartao-expirado').expect(201);
      expect(novo.body.id).not.toBe(link.body.id);
      expect(novo.body.card.paymentUrl).not.toBe(link.body.card.paymentUrl);
    });

    it('cartão pago duas vezes no mesmo link: o segundo pagamento vira PAGO_DUPLICADO com estorno pendente', async () => {
      const link = await h.card(m, 'insc-cartao-duas-vezes').expect(201);
      const reference = await linkReference(link.body.id);
      await h.cardWebhook(h.mock.simulatePayment(reference)).expect(200);
      expect(await h.statusesOf('insc-cartao-duas-vezes')).toEqual(['CONFIRMADA']);

      const second = h.mock.simulatePayment(reference, { force: true });
      await h.cardWebhook(second).expect(200);
      expect((await h.cardWebhook(second).expect(200)).body).toMatchObject({ duplicated: 1 });

      const attempts = await attemptsOf('insc-cartao-duas-vezes');
      expect(attempts.map((t) => t.status)).toEqual(['CONFIRMADA', 'PAGO_DUPLICADO']);
      expect(attempts[1]).toMatchObject({ duplicateOfId: link.body.id, providerPaymentId: second.paymentId, method: 'CREDIT_CARD' });
      const refunds = await refundsOf('insc-cartao-duas-vezes');
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ transactionId: attempts[1].id, status: 'PENDENTE_ANALISE', reason: 'SEGUNDO_PAGAMENTO_DA_TENTATIVA', amountCents: 15050 });
      expect(await h.charge(m, 'insc-cartao-duas-vezes')).toMatchObject({ status: 'PAGA', paidTransactionId: link.body.id });
    });
  });

  describe('vencimento', () => {
    it('Pix vencido: a nova solicitação consulta o banco antes de liberar e só então gera outro QR Code', async () => {
      const first = await h.pix(m, 'insc-pix-vencido').expect(201);
      await h.expireAttempt(first.body.id);

      const second = await h.pix(m, 'insc-pix-vencido').expect(201);
      expect(second.body.id).not.toBe(first.body.id);
      expect(await h.statusesOf('insc-pix-vencido')).toEqual(['EXPIRADA', 'PENDENTE']);
      // O banco ainda aceitaria o QR antigo, então ele foi removido antes de a cobrança ser liberada.
      expect(h.bank.cobs.get(first.body.pix.txid)!.status).toBe('REMOVIDA_PELO_USUARIO_RECEBEDOR');
    });

    it('Pix vencido mas já pago no banco: confirma o pagamento em vez de gerar outro QR Code', async () => {
      const first = await h.pix(m, 'insc-pix-vencido-pago').expect(201);
      h.bank.payPix(first.body.pix.txid);
      await h.expireAttempt(first.body.id);
      const cobs = h.bank.cobs.size;

      const res = await h.pix(m, 'insc-pix-vencido-pago').expect(409);
      expect(res.body.error.code).toBe('PAGAMENTO_JA_CONFIRMADO');
      expect(h.bank.cobs.size).toBe(cobs);
      expect(await h.statusesOf('insc-pix-vencido-pago')).toEqual(['CONFIRMADA']);
    });

    it('cobrança com prazo vencido não aceita novas tentativas e é encerrada quando não resta tentativa ativa', async () => {
      const prazo = new Date(Date.now() + 3_600_000).toISOString();
      const first = await h.pay(m, { method: 'PIX', amount: 5000, externalReference: 'insc-prazo', customer, chargeExpiresAt: prazo }).expect(201);
      expect((await h.charge(m, 'insc-prazo')).expiresAt).toBe(prazo);

      await h.prisma.charge.update({ where: { id: first.body.chargeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const late = await h.pay(m, { method: 'BOLETO', amount: 5000, externalReference: 'insc-prazo', customer, boleto: { dueDate: dueDateIn(5) } }).expect(409);
      expect(late.body.error.code).toBe('COBRANCA_ENCERRADA');

      await h.job.run(); // ainda há um QR Code válido: a cobrança continua aberta
      expect((await h.charge(m, 'insc-prazo')).status).toBe('ABERTA');

      await h.expireAttempt(first.body.id);
      const stats = await h.job.run();
      expect(stats.chargesExpired).toBe(1);
      expect(await h.charge(m, 'insc-prazo')).toMatchObject({ status: 'EXPIRADA', awaitingConfirmation: false, activeAttempt: null });
    });
  });
});
