import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentProvider, TransactionStatus } from '@prisma/client';
import { BankInvalidResponseError, ConvenioMisconfiguredError, UnsupportedPaymentMethodError, ValidationError } from '../../../../common/errors';
import { formatCivilDate } from '../../../../common/utils/date-helpers';
import { centsToDecimalString } from '../../../../common/utils/money';
import { onlyDigits, toBankSafeText } from '../../../../common/utils/text';
import { isNumericDocument } from '../../../../common/validation/brazilian-document';
import { digitableLineToBarcode, isValidDigitableLine } from '../../boleto/boleto-barcode';
import {
  BoletoChargeRequest,
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
import { BacenPixClient, mapCobWithData, parseBacenPixWebhook, pixDataFromCob } from '../shared/bacen-pix.client';
import { assertNoProblems, parseConvenioPart } from '../shared/convenio-validation';
import { OAuth2TokenProvider } from '../shared/oauth2-token.provider';
import { CAIXA_SIBAR_DEFAULT_URLS, CaixaSettings, caixaCredentialsSchema, caixaSettingsSchema } from './caixa.config';
import { CaixaSibarClient, buildConsultaBoletoXml, buildIncluiBoletoXml, sibarAuthHash } from './caixa-sibar.client';

const PROVIDER = PaymentProvider.CAIXA;

/** Nosso número SIGCB: "14" (registrada, emissão pelo beneficiário) + 15 dígitos sequenciais. */
export function caixaNossoNumero(sequence: bigint): string {
  const seq = sequence.toString();
  if (seq.length > 15) throw new ValidationError('Sequencial de nosso número esgotado para o convênio');
  return `14${seq.padStart(15, '0')}`;
}

@Injectable()
export class CaixaAdapter implements IPaymentGateway {
  readonly provider = PROVIDER;
  readonly supportedMethods: ReadonlySet<PaymentMethod> = new Set([PaymentMethod.PIX, PaymentMethod.BOLETO]);
  private readonly logger = new Logger(CaixaAdapter.name);

  constructor(private readonly tokens: OAuth2TokenProvider) {}

  validateConvenio(input: ConvenioValidationInput): ValidatedConvenioConfig {
    const settings = parseConvenioPart(caixaSettingsSchema, input.settings, 'settings');
    const credentials = parseConvenioPart(caixaCredentialsSchema, input.credentials, 'credentials');
    const problems: string[] = [];
    if (input.supportedMethods.includes(PaymentMethod.PIX)) {
      if (!credentials.clientId || !credentials.clientSecret) problems.push('credentials.clientId/clientSecret são obrigatórios para PIX');
      if (!credentials.pixKey) problems.push('credentials.pixKey é obrigatório para PIX');
      if (!settings.urls.oauth || !settings.urls.pix) problems.push('settings.urls.oauth e settings.urls.pix são obrigatórios para PIX na Caixa');
      if (!input.hasCertificate) problems.push('certificado mTLS é obrigatório para a API Pix da Caixa');
    }
    assertNoProblems(problems);
    return { settings, credentials, urls: Object.values(settings.urls).filter((u): u is string => !!u) };
  }

  providerReferenceFor(_ctx: GatewayContext, request: ChargeRequest): string | undefined {
    if (request.method === PaymentMethod.PIX) return request.txid;
    if (request.method === PaymentMethod.BOLETO) return caixaNossoNumero(request.sequence);
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

  async getChargeStatus(ctx: GatewayContext, ref: ChargeReference): Promise<ChargeStatusResult> {
    const settings = this.settings(ctx);
    if (ref.method === PaymentMethod.PIX) {
      const cob = await this.pixClient(ctx, settings).getCob(ref.providerReference);
      return mapCobWithData(PROVIDER, cob, { name: settings.pixMerchantName, city: settings.pixMerchantCity });
    }
    if (ref.method === PaymentMethod.BOLETO) {
      const auth = sibarAuthHash({
        codigoBeneficiario: settings.codigoBeneficiario,
        nossoNumero: ref.providerReference,
        beneficiaryDocument: ctx.beneficiary.document,
      });
      const xml = buildConsultaBoletoXml(this.header(settings, auth, 'CONSULTA_BOLETO'), settings.codigoBeneficiario, ref.providerReference);
      const result = await new CaixaSibarClient(ctx.http).call(this.urls(ctx, settings).sibarConsulta, 'ConsultaBoleto', xml, 'boleto.get', true);
      // A situação do título vem na mensagem de retorno (ex.: "SITUACAO DO TITULO: LIQUIDADO").
      // Validar textos exatos na homologação; na dúvida mantemos PENDING (conservador).
      const text = result.messages.join(' ').toUpperCase();
      const situacao = /SITUACAO DO TITULO:\s*([A-Z ]+)/.exec(text)?.[1]?.trim() ?? 'DESCONHECIDA';
      if (/LIQUIDAD/.test(situacao)) return { status: TransactionStatus.PAID, providerStatus: situacao };
      if (/BAIXAD/.test(situacao)) return { status: TransactionStatus.CANCELED, providerStatus: situacao };
      return { status: TransactionStatus.PENDING, providerStatus: situacao };
    }
    throw new UnsupportedPaymentMethodError(PROVIDER, ref.method);
  }

  /**
   * Pix: webhook padrão BACEN. Boleto: o SIGCB não envia webhook — a liquidação é conciliada
   * pela reconciliação ativa (CONSULTA_BOLETO) e/ou arquivo de retorno CNAB 240.
   * Aceita também { nossoNumero } para integrações via middleware/retorno processado.
   */
  parseWebhook(payload: unknown): NormalizedWebhookEvent[] {
    const pix = parseBacenPixWebhook(payload);
    if (pix) return pix;
    const items = (Array.isArray(payload) ? payload : [payload]) as Array<Record<string, unknown>>;
    return items
      .filter((i) => i && typeof i === 'object' && typeof i.nossoNumero === 'string' && /^\d{17}$/.test(i.nossoNumero))
      .map((i) => ({
        eventKey: `boleto:${String(i.nossoNumero)}:${typeof i.dataPagamento === 'string' ? i.dataPagamento : 'notificacao'}`,
        type: 'BOLETO_PAID' as const,
        providerReference: String(i.nossoNumero),
        ...(typeof i.codigoBeneficiario === 'string' ? { convenioHint: { settingsKey: 'codigoBeneficiario', value: i.codigoBeneficiario } } : {}),
        raw: { nossoNumero: i.nossoNumero, dataPagamento: i.dataPagamento },
      }));
  }

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
    return { status: TransactionStatus.PENDING, providerReference: cob.txid, providerData: { pix }, expiresAt };
  }

  private async createBoleto(ctx: GatewayContext, req: BoletoChargeRequest): Promise<ChargeResult> {
    const settings = this.settings(ctx);
    const payer = req.payer;
    if (!payer.address) throw new ValidationError('Endereço do pagador é obrigatório para boleto');
    if (!isNumericDocument(payer.document) || !isNumericDocument(ctx.beneficiary.document)) {
      throw new ValidationError('O webservice SIGCB da Caixa ainda não aceita CNPJ alfanumérico');
    }

    const nossoNumero = caixaNossoNumero(req.sequence);
    const auth = sibarAuthHash({
      codigoBeneficiario: settings.codigoBeneficiario,
      nossoNumero,
      dueDate: req.dueDate,
      amountCents: req.amountCents,
      beneficiaryDocument: ctx.beneficiary.document,
    });
    const xml = buildIncluiBoletoXml(this.header(settings, auth, 'INCLUI_BOLETO'), {
      codigoBeneficiario: settings.codigoBeneficiario,
      nossoNumero,
      numeroDocumento: req.sequence.toString().slice(-11),
      dueDate: req.dueDate,
      issueDate: req.issueDate,
      amountCents: req.amountCents,
      finePercent: req.finePercent,
      interestMonthlyPercent: req.interestMonthlyPercent,
      acceptUntilDaysAfterDue: req.acceptUntilDaysAfterDue,
      messages: req.instructions.map((m) => toBankSafeText(m, 40)).filter(Boolean),
      payer: {
        documentType: payer.documentType,
        document: payer.document,
        name: toBankSafeText(payer.name, 40),
        street: toBankSafeText(`${payer.address.street} ${payer.address.number} ${payer.address.complement ?? ''}`, 40),
        neighborhood: toBankSafeText(payer.address.neighborhood, 15),
        city: toBankSafeText(payer.address.city, 15),
        state: payer.address.state.toUpperCase(),
        zipCode: onlyDigits(payer.address.zipCode),
      },
    });

    const result = await new CaixaSibarClient(ctx.http).call(this.urls(ctx, settings).sibarManutencao, 'IncluiBoleto', xml, 'boleto.create', false);
    const inclui = (result.dados.INCLUI_BOLETO ?? {}) as Record<string, unknown>;
    const digitableLine = onlyDigits(String(inclui.LINHA_DIGITAVEL ?? ''));
    const barcode = onlyDigits(String(inclui.CODIGO_BARRAS ?? ''));
    if (!digitableLine || !barcode) {
      throw new BankInvalidResponseError({ provider: PROVIDER, operation: 'boleto.create', bankMessage: 'resposta sem linha digitável/código de barras' });
    }
    if (!isValidDigitableLine(digitableLine) || digitableLineToBarcode(digitableLine) !== barcode) {
      this.logger.error({ msg: 'caixa boleto returned inconsistent digitable line/barcode', transactionId: req.transactionId });
    }
    const bankNossoNumero = typeof inclui.NOSSO_NUMERO === 'string' && inclui.NOSSO_NUMERO ? inclui.NOSSO_NUMERO : nossoNumero;
    return {
      status: TransactionStatus.PENDING,
      providerReference: bankNossoNumero,
      providerData: {
        boleto: {
          nossoNumero: bankNossoNumero,
          digitableLine,
          barcode,
          dueDate: formatCivilDate(req.dueDate, 'yyyy-MM-dd'),
          issueDate: formatCivilDate(req.issueDate, 'yyyy-MM-dd'),
          ...(typeof inclui.URL === 'string' && inclui.URL.startsWith('https://') ? { bankPdfUrl: inclui.URL } : {}),
        },
      },
    };
  }

  private header(settings: CaixaSettings, autenticacao: string, operacao: 'INCLUI_BOLETO' | 'CONSULTA_BOLETO') {
    return {
      versao: settings.versaoLeiaute,
      autenticacao,
      usuarioServico: settings.usuarioServico,
      operacao,
      sistemaOrigem: settings.sistemaOrigem,
      unidade: settings.unidade,
    };
  }

  private settings(ctx: GatewayContext): CaixaSettings {
    return caixaSettingsSchema.parse(ctx.settings);
  }

  private urls(ctx: GatewayContext, settings: CaixaSettings) {
    return { ...CAIXA_SIBAR_DEFAULT_URLS[ctx.environment], ...settings.urls };
  }

  private pixClient(ctx: GatewayContext, settings: CaixaSettings): BacenPixClient {
    const { oauth, pix } = settings.urls;
    if (!oauth || !pix) throw new ConvenioMisconfiguredError(ctx.convenioId, 'URLs de Pix ausentes');
    const scope = settings.pixOAuthScope;
    return new BacenPixClient({
      provider: PROVIDER,
      baseUrl: pix,
      http: ctx.http,
      getToken: (force) =>
        this.tokens.getToken(
          {
            http: ctx.http,
            tokenUrl: oauth,
            clientId: ctx.credentials.clientId ?? '',
            clientSecret: ctx.credentials.clientSecret ?? '',
            scope,
            cacheKey: `${PROVIDER}:${ctx.convenioId}:${ctx.credentialsVersion}:${scope ?? 'default'}`,
          },
          force,
        ),
    });
  }
}
