import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentProvider, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { z } from 'zod';
import { BankIntegrationError, BankRejectedError, ConvenioMisconfiguredError, UnsupportedPaymentMethodError, ValidationError } from '../../../../common/errors';
import { formatCivilDate, parseBrDate } from '../../../../common/utils/date-helpers';
import { centsToDecimalString, decimalToCents } from '../../../../common/utils/money';
import { onlyDigits, toBankSafeText } from '../../../../common/utils/text';
import { isNumericDocument } from '../../../../common/validation/brazilian-document';
import { digitableLineToBarcode, isValidDigitableLine } from '../../boleto/boleto-barcode';
import {
  BoletoChargeRequest,
  CancelResult,
  ChargeReference,
  ChargeRequest,
  ChargeResult,
  ChargeStatusResult,
  ConvenioValidationInput,
  GatewayContext,
  IPaymentGateway,
  NormalizedWebhookEvent,
  PixChargeRequest,
  ValidatedConvenioConfig,
} from '../../domain/payment-gateway.port';
import { authorizedRequest } from '../shared/authorized-request';
import { BacenPixClient, cancelCob, mapCobWithData, parseBacenPixWebhook, pixDataFromCob } from '../shared/bacen-pix.client';
import { parseBankJson } from '../shared/bank-response';
import { assertNoProblems, parseConvenioPart } from '../shared/convenio-validation';
import { OAuth2TokenProvider } from '../shared/oauth2-token.provider';
import { BB_SCOPES, BbSettings, bbCredentialsSchema, bbSettingsSchema, resolveBbUrls } from './bb.config';

const PROVIDER = PaymentProvider.BANCO_DO_BRASIL;

const boletoCreateResponseSchema = z
  .object({
    numero: z.string().regex(/^\d{1,20}$/),
    linhaDigitavel: z.string(),
    codigoBarraNumerico: z.string(),
    qrCode: z.object({ url: z.string().optional(), txId: z.string().optional(), emv: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const boletoGetResponseSchema = z
  .object({
    codigoEstadoTituloCobranca: z.coerce.number().int(),
    codigoLinhaDigitavel: z.string().optional(),
    linhaDigitavel: z.string().optional(),
    codigoBarraNumerico: z.string().optional(),
    dataVencimentoTituloCobranca: z.string().optional(),
    dataEmissaoTituloCobranca: z.string().optional(),
    valorPagoSacado: z.coerce.number().optional(),
    dataRecebimentoTitulo: z.string().optional(),
    dataCreditoLiquidacao: z.string().optional(),
  })
  .passthrough();

/** Webhook "baixa operacional" de boletos BB (payload em lista). */
const boletoWebhookItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    codigoEstadoBaixaOperacional: z.coerce.number().int(),
    dataLiquidacao: z.string().optional(),
    valorPagoSacado: z.coerce.number().optional(),
    numeroConvenio: z.coerce.number().int().optional(),
  })
  .passthrough();

/** Estados do título na API Cobranças BB (validar a tabela vigente na homologação). */
const BB_PAID_STATES = new Set([6, 10, 11, 12, 16]);
const BB_WRITTEN_OFF_STATES = new Set([7]);

@Injectable()
export class BancoDoBrasilAdapter implements IPaymentGateway {
  readonly provider = PROVIDER;
  readonly supportedMethods: ReadonlySet<PaymentMethod> = new Set([PaymentMethod.PIX, PaymentMethod.BOLETO]);
  private readonly logger = new Logger(BancoDoBrasilAdapter.name);

  constructor(private readonly tokens: OAuth2TokenProvider) {}

  validateConvenio(input: ConvenioValidationInput): ValidatedConvenioConfig {
    const settings = parseConvenioPart(bbSettingsSchema, input.settings, 'settings');
    const credentials = parseConvenioPart(bbCredentialsSchema, input.credentials, 'credentials');
    const problems: string[] = [];
    if (input.supportedMethods.includes(PaymentMethod.PIX) && !credentials.pixKey) {
      problems.push('credentials.pixKey é obrigatório para PIX');
    }
    if (input.environment === ProviderEnvironment.PRODUCTION && !input.hasCertificate) {
      problems.push('certificado mTLS (ICP-Brasil) é obrigatório em produção no Banco do Brasil');
    }
    assertNoProblems(problems);
    return { settings, credentials, urls: Object.values(settings.urls).filter((u): u is string => !!u) };
  }

  providerReferenceFor(ctx: GatewayContext, request: ChargeRequest): string | undefined {
    if (request.method === PaymentMethod.PIX) return request.txid;
    if (request.method === PaymentMethod.BOLETO) return this.numeroTituloCliente(ctx, this.settings(ctx), request.sequence);
    return undefined;
  }

  async createCharge(ctx: GatewayContext, request: ChargeRequest): Promise<ChargeResult> {
    switch (request.method) {
      case PaymentMethod.PIX:
        return this.createPix(ctx, request);
      case PaymentMethod.BOLETO:
        return this.createBoleto(ctx, request);
      default:
        throw new UnsupportedPaymentMethodError(PROVIDER, request.method);
    }
  }

  async getStatus(ctx: GatewayContext, ref: ChargeReference): Promise<ChargeStatusResult> {
    const settings = this.settings(ctx);
    if (ref.method === PaymentMethod.PIX) {
      const cob = await this.pixClient(ctx, settings).getCob(ref.providerReference);
      return mapCobWithData(PROVIDER, cob, { name: settings.pixMerchantName, city: settings.pixMerchantCity });
    }
    if (ref.method === PaymentMethod.BOLETO) {
      const urls = resolveBbUrls(ctx.environment, settings);
      const res = await authorizedRequest(ctx.http, (force) => this.token(ctx, urls.oauth, BB_SCOPES.cobranca, force), {
        method: 'GET',
        url: `${urls.cobranca}/boletos/${encodeURIComponent(ref.providerReference)}`,
        operation: 'boleto.get',
        query: { 'gw-dev-app-key': ctx.credentials.developerAppKey, numeroConvenio: settings.numeroConvenio },
        idempotent: true,
      });
      const body = parseBankJson(PROVIDER, 'boleto.get', res, boletoGetResponseSchema);
      const state = body.codigoEstadoTituloCobranca;
      const line = onlyDigits(body.linhaDigitavel ?? body.codigoLinhaDigitavel ?? '');
      const due = parseBrDate(body.dataVencimentoTituloCobranca ?? '');
      const issue = parseBrDate(body.dataEmissaoTituloCobranca ?? '');
      const providerData =
        line.length === 47 && due
          ? {
              boleto: {
                nossoNumero: ref.providerReference,
                digitableLine: line,
                barcode: body.codigoBarraNumerico ? onlyDigits(body.codigoBarraNumerico) : digitableLineToBarcode(line),
                dueDate: formatCivilDate(due, 'yyyy-MM-dd'),
                issueDate: formatCivilDate(issue ?? due, 'yyyy-MM-dd'),
              },
            }
          : undefined;
      if (BB_PAID_STATES.has(state)) {
        // A consulta do título não identifica cada liquidação: um segundo pagamento do mesmo boleto
        // só é percebido pelo webhook de baixa operacional (ver parseWebhook).
        return {
          status: TransactionStatus.CONFIRMADA,
          providerStatus: `ESTADO_${state}`,
          providerData,
          payments: [
            {
              amountCents: body.valorPagoSacado !== undefined ? decimalToCents(body.valorPagoSacado) : undefined,
              paidAt: parseBrDate(body.dataRecebimentoTitulo ?? '') ?? parseBrDate(body.dataCreditoLiquidacao ?? ''),
            },
          ],
        };
      }
      if (BB_WRITTEN_OFF_STATES.has(state)) return { status: TransactionStatus.CANCELADA, providerStatus: `ESTADO_${state}`, providerData };
      return { status: TransactionStatus.PENDENTE, providerStatus: `ESTADO_${state}`, providerData };
    }
    throw new UnsupportedPaymentMethodError(PROVIDER, ref.method);
  }

  async cancel(ctx: GatewayContext, ref: ChargeReference): Promise<CancelResult> {
    if (ref.method === PaymentMethod.PIX) return cancelCob(this.pixClient(ctx, this.settings(ctx)), ref.providerReference);
    if (ref.method === PaymentMethod.BOLETO) return this.cancelBoleto(ctx, ref);
    throw new UnsupportedPaymentMethodError(PROVIDER, ref.method);
  }

  /**
   * Baixa (cancelamento) do boleto: POST /boletos/{id}/baixar, com o número do convênio no corpo.
   *
   * TODO(homologação BB): a operação consta da API Cobranças v2, mas o corpo da requisição, os códigos
   * de erro e o comportamento para boleto recém-pago (pago hoje em outro banco, ainda em compensação)
   * NÃO foram conferidos na referência oficial nesta entrega. Por isso nada aqui é presumido:
   *  - resposta 2xx só indica que o pedido foi aceito; quem confirma a baixa é getStatus() (estado 7);
   *  - qualquer recusa é classificada consultando o título, nunca pelo código de erro.
   */
  private async cancelBoleto(ctx: GatewayContext, ref: ChargeReference): Promise<CancelResult> {
    const settings = this.settings(ctx);
    const urls = resolveBbUrls(ctx.environment, settings);
    try {
      await authorizedRequest(ctx.http, (force) => this.token(ctx, urls.oauth, BB_SCOPES.cobranca, force), {
        method: 'POST',
        url: `${urls.cobranca}/boletos/${encodeURIComponent(ref.providerReference)}/baixar`,
        operation: 'boleto.cancel',
        query: { 'gw-dev-app-key': ctx.credentials.developerAppKey },
        json: { numeroConvenio: settings.numeroConvenio },
        idempotent: false,
      });
      return { outcome: 'CANCELED', providerStatus: 'BAIXA_SOLICITADA' };
    } catch (err) {
      if (!(err instanceof BankIntegrationError)) throw err;
      if (!(err instanceof BankRejectedError)) return { outcome: 'TECHNICAL_ERROR', error: err };
      try {
        const current = await this.getStatus(ctx, ref);
        if (current.status === TransactionStatus.CONFIRMADA) return { outcome: 'ALREADY_PAID', providerStatus: current.providerStatus, payments: current.payments };
        if (current.status === TransactionStatus.CANCELADA) return { outcome: 'CANCELED', providerStatus: current.providerStatus };
        return { outcome: 'REFUSED', providerStatus: current.providerStatus, reason: err.bankMessage };
      } catch (lookupErr) {
        if (lookupErr instanceof BankIntegrationError) return { outcome: 'TECHNICAL_ERROR', error: lookupErr };
        throw lookupErr;
      }
    }
  }

  parseWebhook(payload: unknown): NormalizedWebhookEvent[] {
    const pix = parseBacenPixWebhook(payload);
    if (pix) return pix;

    const items = z.array(boletoWebhookItemSchema).safeParse(Array.isArray(payload) ? payload : [payload]);
    if (!items.success) return [];
    return items.data.map((item) => ({
      eventKey: `boleto:${item.id}:${item.codigoEstadoBaixaOperacional}:${item.dataLiquidacao ?? ''}`,
      // 1 = baixa operacional BB, 2 = baixa operacional outro banco, 10 = cancelamento da baixa
      type: item.codigoEstadoBaixaOperacional === 10 ? 'UNKNOWN' : 'BOLETO_PAID',
      providerReference: item.id,
      // TODO(homologação BB): confirmar qual campo identifica cada liquidação. Usamos data e hora da
      // liquidação: duas notificações do mesmo título com horários diferentes são tratadas como dois
      // pagamentos (o segundo vira PAGO_DUPLICADO, sem estorno automático). Sem dataLiquidacao não há
      // como distinguir, e o evento é tratado como repetição do mesmo pagamento.
      ...(item.dataLiquidacao && item.codigoEstadoBaixaOperacional !== 10 ? { paymentId: `boleto:${item.id}:${item.dataLiquidacao}` } : {}),
      amountCents: item.valorPagoSacado !== undefined ? decimalToCents(item.valorPagoSacado) : undefined,
      ...(item.numeroConvenio !== undefined ? { convenioHint: { settingsKey: 'numeroConvenio', value: item.numeroConvenio } } : {}),
      // Sem dados do portador (PII) na trilha de auditoria.
      raw: { id: item.id, codigoEstadoBaixaOperacional: item.codigoEstadoBaixaOperacional, dataLiquidacao: item.dataLiquidacao },
    }));
  }

  // ---------------------------------------------------------------------------
  // PIX
  // ---------------------------------------------------------------------------

  private async createPix(ctx: GatewayContext, req: PixChargeRequest): Promise<ChargeResult> {
    const settings = this.settings(ctx);
    const pixKey = ctx.credentials.pixKey;
    if (!pixKey) throw new ConvenioMisconfiguredError(ctx.convenioId, 'chave Pix ausente');

    const cob = await this.pixClient(ctx, settings).createCob(req.txid, {
      calendario: { expiracao: req.expiresInSeconds },
      devedor:
        req.payer.documentType === 'CPF'
          ? { cpf: req.payer.document, nome: req.payer.name.slice(0, 200) }
          : { cnpj: req.payer.document, nome: req.payer.name.slice(0, 200) },
      valor: { original: centsToDecimalString(req.amountCents) },
      chave: pixKey,
      ...(req.description ? { solicitacaoPagador: req.description.slice(0, 140) } : {}),
    });

    const { pix, expiresAt } = pixDataFromCob(PROVIDER, cob, { name: settings.pixMerchantName, city: settings.pixMerchantCity });
    return { status: TransactionStatus.PENDENTE, providerReference: cob.txid, providerData: { pix }, expiresAt };
  }

  // ---------------------------------------------------------------------------
  // BOLETO (API Cobranças v2)
  // ---------------------------------------------------------------------------

  private async createBoleto(ctx: GatewayContext, req: BoletoChargeRequest): Promise<ChargeResult> {
    const settings = this.settings(ctx);
    const urls = resolveBbUrls(ctx.environment, settings);
    const payer = req.payer;
    if (!payer.address) throw new ValidationError('Endereço do pagador é obrigatório para boleto');
    if (!isNumericDocument(payer.document)) {
      throw new ValidationError('A API de cobrança do BB ainda não aceita CNPJ alfanumérico do pagador');
    }

    const numeroTituloCliente = this.numeroTituloCliente(ctx, settings, req.sequence);
    const dueDate = formatCivilDate(req.dueDate, 'dd.MM.yyyy');

    const body = {
      numeroConvenio: settings.numeroConvenio,
      numeroCarteira: settings.numeroCarteira,
      numeroVariacaoCarteira: settings.numeroVariacaoCarteira,
      codigoModalidade: settings.codigoModalidade,
      dataEmissao: formatCivilDate(req.issueDate, 'dd.MM.yyyy'),
      dataVencimento: dueDate,
      valorOriginal: Number(centsToDecimalString(req.amountCents)),
      valorAbatimento: 0,
      quantidadeDiasProtesto: 0,
      quantidadeDiasNegativacao: 0,
      indicadorAceiteTituloVencido: req.acceptUntilDaysAfterDue ? 'S' : 'N',
      ...(req.acceptUntilDaysAfterDue ? { numeroDiasLimiteRecebimento: req.acceptUntilDaysAfterDue } : {}),
      codigoAceite: 'N',
      codigoTipoTitulo: 2,
      descricaoTipoTitulo: 'DM',
      indicadorPermissaoRecebimentoParcial: 'N',
      numeroTituloBeneficiario: req.transactionId.replace(/-/g, '').slice(0, 15).toUpperCase(),
      campoUtilizacaoBeneficiario: toBankSafeText(req.description, 30),
      numeroTituloCliente,
      mensagemBloquetoOcorrencia: toBankSafeText(req.instructions.join(' '), 165),
      jurosMora: req.interestMonthlyPercent ? { tipo: 2, porcentagem: req.interestMonthlyPercent } : { tipo: 0 },
      multa: req.finePercent
        ? { tipo: 2, data: formatCivilDate(new Date(req.dueDate.getTime() + 86_400_000), 'dd.MM.yyyy'), porcentagem: req.finePercent }
        : { tipo: 0 },
      desconto: { tipo: 0 },
      pagador: {
        tipoInscricao: payer.documentType === 'CPF' ? 1 : 2,
        numeroInscricao: Number(payer.document),
        nome: toBankSafeText(payer.name, 60),
        endereco: toBankSafeText(`${payer.address.street} ${payer.address.number} ${payer.address.complement ?? ''}`, 60),
        cep: Number(onlyDigits(payer.address.zipCode)),
        cidade: toBankSafeText(payer.address.city, 20),
        bairro: toBankSafeText(payer.address.neighborhood, 20),
        uf: payer.address.state.toUpperCase(),
        ...(payer.phone ? { telefone: onlyDigits(payer.phone).slice(0, 15) } : {}),
      },
      indicadorPix: settings.boletoComPix ? 'S' : 'N',
    };

    const res = await authorizedRequest(ctx.http, (force) => this.token(ctx, urls.oauth, BB_SCOPES.cobranca, force), {
      method: 'POST',
      url: `${urls.cobranca}/boletos`,
      operation: 'boleto.create',
      query: { 'gw-dev-app-key': ctx.credentials.developerAppKey },
      json: body,
      idempotent: false, // POST de registro não é idempotente: nunca retentar após envio
    });
    const created = parseBankJson(PROVIDER, 'boleto.create', res, boletoCreateResponseSchema);

    const digitableLine = onlyDigits(created.linhaDigitavel);
    const barcode = onlyDigits(created.codigoBarraNumerico);
    if (!isValidDigitableLine(digitableLine) || digitableLineToBarcode(digitableLine) !== barcode) {
      // O título FOI registrado — o banco é a fonte da verdade; apenas alertamos para investigação.
      this.logger.error({ msg: 'bb boleto returned inconsistent digitable line/barcode', transactionId: req.transactionId });
    }

    return {
      status: TransactionStatus.PENDENTE,
      providerReference: created.numero,
      providerData: {
        boleto: {
          nossoNumero: created.numero,
          digitableLine,
          barcode,
          dueDate: formatCivilDate(req.dueDate, 'yyyy-MM-dd'),
          issueDate: formatCivilDate(req.issueDate, 'yyyy-MM-dd'),
          ...(created.qrCode?.emv ? { pixCopyPaste: created.qrCode.emv } : {}),
        },
      },
    };
  }

  // ---------------------------------------------------------------------------

  /** Convênio de 7 dígitos: nosso número = convênio (7) + sequencial (10); numeroTituloCliente = "000" + nosso número. */
  private numeroTituloCliente(ctx: GatewayContext, settings: BbSettings, sequence: bigint): string {
    const seq = sequence.toString();
    if (seq.length > 10) throw new ConvenioMisconfiguredError(ctx.convenioId, 'sequencial de nosso número esgotado');
    return `000${settings.numeroConvenio.toString().padStart(7, '0')}${seq.padStart(10, '0')}`;
  }

  private settings(ctx: GatewayContext): BbSettings {
    return bbSettingsSchema.parse(ctx.settings);
  }

  private pixClient(ctx: GatewayContext, settings: BbSettings): BacenPixClient {
    const urls = resolveBbUrls(ctx.environment, settings);
    return new BacenPixClient({
      provider: PROVIDER,
      baseUrl: urls.pix,
      http: ctx.http,
      query: { 'gw-dev-app-key': ctx.credentials.developerAppKey ?? '' },
      getToken: (force) => this.token(ctx, urls.oauth, BB_SCOPES.pix, force),
    });
  }

  private token(ctx: GatewayContext, tokenUrl: string, scope: string, forceRefresh: boolean): Promise<string> {
    return this.tokens.getToken(
      {
        http: ctx.http,
        tokenUrl,
        clientId: ctx.credentials.clientId ?? '',
        clientSecret: ctx.credentials.clientSecret ?? '',
        scope,
        cacheKey: `${PROVIDER}:${ctx.convenioId}:${ctx.credentialsVersion}:${scope}`,
        authStyle: 'basic',
      },
      forceRefresh,
    );
  }
}
