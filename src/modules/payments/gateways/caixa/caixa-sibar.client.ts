import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { BankInvalidResponseError, BankRejectedError, BankUnavailableError } from '../../../../common/errors';
import { formatBr, formatCivilDate } from '../../../../common/utils/date-helpers';
import { centsToDecimalString } from '../../../../common/utils/money';
import { escapeXml } from '../../../../common/utils/text';
import { BankHttpClient } from '../../../../infra/http/bank-http-client';
import { toBankError } from '../shared/bank-response';

// Webservice de Cobrança Bancária Caixa (SIBAR/SIGCB) — SOAP 1.1.
// Referência: "Leiaute de Mensagens – Webservice Cobrança Caixa" (manual do beneficiário).

const NS_MANUTENCAO = 'http://caixa.gov.br/sibar/manutencao_cobranca_bancaria/boleto/externo';
const NS_CONSULTA = 'http://caixa.gov.br/sibar/consulta_cobranca_bancaria/boleto';
const NS_SIBAR = 'http://caixa.gov.br/sibar';

/**
 * Hash de autenticação SIBAR: Base64(SHA-256(
 *   codigoBeneficiario(7) + nossoNumero(17) + vencimento DDMMAAAA(8) + valor em centavos(15) + CPF/CNPJ beneficiário(14)
 * )). Em consultas, vencimento e valor vão zerados.
 */
export function sibarAuthHash(p: { codigoBeneficiario: string; nossoNumero: string; dueDate?: Date; amountCents?: number; beneficiaryDocument: string }): string {
  const raw =
    p.codigoBeneficiario.padStart(7, '0') +
    p.nossoNumero.padStart(17, '0') +
    (p.dueDate ? formatCivilDate(p.dueDate, 'ddMMyyyy') : '00000000') +
    String(p.amountCents ?? 0).padStart(15, '0') +
    p.beneficiaryDocument.padStart(14, '0');
  return createHash('sha256').update(raw, 'ascii').digest('base64');
}

export interface SibarHeaderInput {
  versao: string;
  autenticacao: string;
  usuarioServico: string;
  operacao: 'INCLUI_BOLETO' | 'CONSULTA_BOLETO';
  sistemaOrigem: string;
  unidade: string;
  now?: Date;
}

export interface IncluiBoletoInput {
  codigoBeneficiario: string;
  nossoNumero: string;
  numeroDocumento: string;
  dueDate: Date;
  issueDate: Date;
  amountCents: number;
  finePercent?: number;
  interestMonthlyPercent?: number;
  acceptUntilDaysAfterDue?: number;
  messages: string[];
  payer: {
    documentType: 'CPF' | 'CNPJ';
    document: string;
    name: string;
    street: string;
    neighborhood: string;
    city: string;
    state: string;
    zipCode: string;
  };
}

const x = (tag: string, value: string | number): string => `<${tag}>${escapeXml(String(value))}</${tag}>`;

function header(h: SibarHeaderInput): string {
  return (
    '<sib:HEADER>' +
    x('VERSAO', h.versao) +
    x('AUTENTICACAO', h.autenticacao) +
    x('USUARIO_SERVICO', h.usuarioServico) +
    x('OPERACAO', h.operacao) +
    x('SISTEMA_ORIGEM', h.sistemaOrigem) +
    x('UNIDADE', h.unidade) +
    x('DATA_HORA', formatBr(h.now ?? new Date(), 'yyyyMMddHHmmss')) +
    '</sib:HEADER>'
  );
}

function envelope(ns: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ext="${ns}" xmlns:sib="${NS_SIBAR}">` +
    `<soapenv:Header/><soapenv:Body><ext:SERVICO_ENTRADA>${body}</ext:SERVICO_ENTRADA></soapenv:Body></soapenv:Envelope>`
  );
}

/** Todos os valores passam por escapeXml — sem risco de XML injection a partir de dados do pagador. */
export function buildIncluiBoletoXml(h: SibarHeaderInput, d: IncluiBoletoInput): string {
  const p = d.payer;
  const juros = d.interestMonthlyPercent
    ? `<JUROS_MORA>${x('TIPO', 'TAXA_MENSAL')}${x('DATA', formatCivilDate(new Date(d.dueDate.getTime() + 86_400_000), 'yyyy-MM-dd'))}${x('PERCENTUAL', d.interestMonthlyPercent.toFixed(2))}</JUROS_MORA>`
    : `<JUROS_MORA>${x('TIPO', 'ISENTO')}${x('VALOR', '0')}</JUROS_MORA>`;
  const multa = d.finePercent
    ? `<MULTA>${x('DATA', formatCivilDate(new Date(d.dueDate.getTime() + 86_400_000), 'yyyy-MM-dd'))}${x('PERCENTUAL', d.finePercent.toFixed(2))}</MULTA>`
    : '';
  const mensagens = d.messages.length
    ? `<FICHA_COMPENSACAO><MENSAGENS>${d.messages.slice(0, 2).map((m) => x('MENSAGEM', m)).join('')}</MENSAGENS></FICHA_COMPENSACAO>`
    : '';
  const pagadorDoc = p.documentType === 'CPF' ? x('CPF', p.document) + x('NOME', p.name) : x('CNPJ', p.document) + x('RAZAO_SOCIAL', p.name);

  return envelope(
    NS_MANUTENCAO,
    header(h) +
      '<DADOS><INCLUI_BOLETO>' +
      x('CODIGO_BENEFICIARIO', d.codigoBeneficiario) +
      '<TITULO>' +
      x('NOSSO_NUMERO', d.nossoNumero) +
      x('NUMERO_DOCUMENTO', d.numeroDocumento) +
      x('DATA_VENCIMENTO', formatCivilDate(d.dueDate, 'yyyy-MM-dd')) +
      x('VALOR', centsToDecimalString(d.amountCents)) +
      x('TIPO_ESPECIE', '99') +
      x('FLAG_ACEITE', 'N') +
      x('DATA_EMISSAO', formatCivilDate(d.issueDate, 'yyyy-MM-dd')) +
      juros +
      x('VALOR_ABATIMENTO', '0') +
      `<POS_VENCIMENTO>${x('ACAO', 'DEVOLVER')}${x('NUMERO_DIAS', d.acceptUntilDaysAfterDue ?? 0)}</POS_VENCIMENTO>` +
      x('CODIGO_MOEDA', '09') +
      `<PAGADOR>${pagadorDoc}<ENDERECO>${x('LOGRADOURO', p.street)}${x('BAIRRO', p.neighborhood)}${x('CIDADE', p.city)}${x('UF', p.state)}${x('CEP', p.zipCode)}</ENDERECO></PAGADOR>` +
      multa +
      mensagens +
      '</TITULO></INCLUI_BOLETO></DADOS>',
  );
}

export function buildConsultaBoletoXml(h: SibarHeaderInput, codigoBeneficiario: string, nossoNumero: string): string {
  return envelope(
    NS_CONSULTA,
    header(h) + `<DADOS><CONSULTA_BOLETO>${x('CODIGO_BENEFICIARIO', codigoBeneficiario)}${x('NOSSO_NUMERO', nossoNumero)}</CONSULTA_BOLETO></DADOS>`,
  );
}

// fast-xml-parser não resolve entidades externas/DTD (sem XXE). parseTagValue=false preserva zeros à esquerda.
const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: false });

type XmlNode = Record<string, unknown>;

function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => collect(n, key, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as XmlNode)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

const asText = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface SibarResult {
  dados: XmlNode;
  messages: string[];
}

/** Interpreta a resposta SOAP: COD_RETORNO ≠ 0 em qualquer nível = recusa de negócio. */
export function parseSibarResponse(xml: string, operation: string): SibarResult {
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (cause) {
    throw new BankInvalidResponseError({ provider: 'CAIXA', operation, cause, bankMessage: 'XML inválido' });
  }
  const fault = collect(doc, 'Fault')[0] as XmlNode | undefined;
  if (fault) {
    const ctx = { provider: 'CAIXA', operation, bankErrorCode: asText(fault.faultcode), bankMessage: asText(fault.faultstring) };
    // Fault "Server" = falha do lado da Caixa (resultado incerto); "Client" = requisição recusada.
    if (/server/i.test(ctx.bankErrorCode ?? '')) throw new BankUnavailableError(ctx, 'UNCERTAIN');
    throw new BankRejectedError(ctx);
  }
  const saida = collect(doc, 'SERVICO_SAIDA')[0] as XmlNode | undefined;
  if (!saida) throw new BankInvalidResponseError({ provider: 'CAIXA', operation, bankMessage: 'SERVICO_SAIDA ausente' });

  const codes = collect(saida, 'COD_RETORNO').map(asText).filter((c): c is string => c !== undefined && c !== '');
  const messages = [...collect(saida, 'RETORNO'), ...collect(saida, 'MSG_RETORNO')]
    .flatMap((m) => (Array.isArray(m) ? m : [m]))
    .map(asText)
    .filter((m): m is string => !!m);
  const failure = codes.find((c) => !/^0+$/.test(c));
  if (failure !== undefined) {
    throw new BankRejectedError({ provider: 'CAIXA', operation, bankErrorCode: failure, bankMessage: messages.join('; ') });
  }
  return { dados: ((saida.DADOS as XmlNode | undefined) ?? {}) as XmlNode, messages };
}

export class CaixaSibarClient {
  constructor(private readonly http: BankHttpClient) {}

  async call(url: string, soapAction: string, xml: string, operation: string, idempotent: boolean): Promise<SibarResult> {
    const res = await this.http.request({
      method: 'POST',
      url,
      operation,
      body: xml,
      headers: { 'content-type': 'text/xml; charset=utf-8', accept: 'text/xml', soapaction: soapAction },
      idempotent,
    });
    // SOAP Fault normalmente vem com HTTP 500: interpreta o envelope antes de classificar por status.
    if ((res.status >= 200 && res.status < 300) || (res.status === 500 && /Fault/.test(res.text))) {
      return parseSibarResponse(res.text, operation);
    }
    throw toBankError('CAIXA', operation, res);
  }
}
