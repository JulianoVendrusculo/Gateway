import { TransactionStatus } from '@prisma/client';
import { z } from 'zod';
import { decimalToCents } from '../../../../common/utils/money';
import { BankHttpClient, BankHttpResponse, HttpMethod } from '../../../../infra/http/bank-http-client';
import { BankIntegrationError, BankInvalidResponseError, BankRejectedError } from '../../../../common/errors';
import { CancelResult, ChargeStatusResult, NormalizedWebhookEvent, PixData, ProviderPayment } from '../../domain/payment-gateway.port';
import { buildDynamicPixBrCode, isValidBrCode } from '../../pix/pix-brcode';
import { authorizedRequest, TokenSupplier } from './authorized-request';
import { parseBankJson } from './bank-response';

// API Pix padronizada pelo BACEN (https://github.com/bacen/pix-api, openapi.yaml) — implementada por todos os PSPs.
// Pontos da especificação em que a v2 se apoia:
//  - PATCH /cob/{txid} ("Revisar cobrança imediata", escopo cob.write) aceita `status` com o único valor
//    REMOVIDA_PELO_USUARIO_RECEBEDOR, e ele precisa ir SOZINHO no corpo.
//  - Se a cobrança não estiver ATIVA, o PATCH responde 400 CobOperacaoInvalida ("A cobrança não está ATIVA,
//    e a presente requisição busca alterá-la"), sem dizer se foi paga ou removida: é preciso consultar.
//  - CONCLUIDA: "já foi paga e, por conseguinte, não pode acolher outro pagamento".
//  - O status é do REGISTRO: cobrança vencida continua ATIVA. A expiração vem de calendario.

export interface CobRequest {
  calendario: { expiracao: number };
  devedor?: { cpf?: string; cnpj?: string; nome: string };
  valor: { original: string; modalidadeAlteracao?: 0 | 1 };
  chave: string;
  solicitacaoPagador?: string;
  infoAdicionais?: Array<{ nome: string; valor: string }>;
}

const pixPaymentSchema = z
  .object({
    endToEndId: z.string(),
    txid: z.string().optional(),
    valor: z.string(),
    horario: z.string(),
  })
  .passthrough();

export const cobResponseSchema = z
  .object({
    txid: z.string(),
    status: z.string(),
    revisao: z.coerce.number().optional(),
    calendario: z.object({ criacao: z.string(), expiracao: z.coerce.number() }).passthrough(),
    location: z.string().optional(),
    loc: z.object({ location: z.string().optional() }).passthrough().optional(),
    pixCopiaECola: z.string().optional(),
    valor: z.object({ original: z.string() }).passthrough(),
    pix: z.array(pixPaymentSchema).optional(),
  })
  .passthrough();

export type CobResponse = z.infer<typeof cobResponseSchema>;

export interface BacenPixClientOptions {
  provider: string;
  baseUrl: string;
  http: BankHttpClient;
  getToken: TokenSupplier;
  /** Query params fixos (ex.: BB exige gw-dev-app-key). */
  query?: Record<string, string>;
}

export class BacenPixClient {
  constructor(private readonly o: BacenPixClientOptions) {}

  /** PUT /cob/{txid}: idempotente por txid — seguro para retry. */
  async createCob(txid: string, body: CobRequest): Promise<CobResponse> {
    const res = await this.call('PUT', `/cob/${encodeURIComponent(txid)}`, 'pix.cob.create', body);
    return parseBankJson(this.o.provider, 'pix.cob.create', res, cobResponseSchema);
  }

  async getCob(txid: string): Promise<CobResponse> {
    const res = await this.call('GET', `/cob/${encodeURIComponent(txid)}`, 'pix.cob.get');
    return parseBankJson(this.o.provider, 'pix.cob.get', res, cobResponseSchema);
  }

  /**
   * PATCH /cob/{txid} com status REMOVIDA_PELO_USUARIO_RECEBEDOR. Pode ser repetido com segurança:
   * se a primeira tentativa surtiu efeito e a resposta se perdeu, a repetição recebe 400 e a
   * consulta seguinte mostra a cobrança já removida.
   */
  async removeCob(txid: string): Promise<CobResponse> {
    const res = await this.call('PATCH', `/cob/${encodeURIComponent(txid)}`, 'pix.cob.remove', { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' });
    return parseBankJson(this.o.provider, 'pix.cob.remove', res, cobResponseSchema);
  }

  private call(method: HttpMethod, path: string, operation: string, json?: unknown): Promise<BankHttpResponse> {
    return authorizedRequest(this.o.http, this.o.getToken, {
      method,
      url: `${this.o.baseUrl.replace(/\/$/, '')}${path}`,
      operation,
      json,
      query: this.o.query,
      idempotent: true,
    });
  }
}

/**
 * Extrai os dados de exibição da cobrança. Se o PSP não devolver um copia-e-cola válido,
 * monta o BR Code dinâmico a partir do location (Manual de Padrões do BACEN).
 */
export function pixDataFromCob(provider: string, cob: CobResponse, merchant: { name: string; city: string }): { pix: PixData; expiresAt: Date } {
  const location = cob.location ?? cob.loc?.location;
  let copyPaste = cob.pixCopiaECola;
  if (!copyPaste || !isValidBrCode(copyPaste)) {
    if (!location) throw new BankInvalidResponseError({ provider, operation: 'pix.cob', bankMessage: 'resposta sem pixCopiaECola e sem location' });
    copyPaste = buildDynamicPixBrCode({ location, merchantName: merchant.name, merchantCity: merchant.city });
  }
  return {
    pix: { txid: cob.txid, copyPaste, location, expiresInSeconds: cob.calendario.expiracao },
    expiresAt: new Date(new Date(cob.calendario.criacao).getTime() + cob.calendario.expiracao * 1000),
  };
}

/** Variante para consultas de status: dados de exibição são opcionais e nunca derrubam a consulta. */
export function mapCobWithData(provider: string, cob: CobResponse, merchant: { name: string; city: string }): ChargeStatusResult {
  const status = mapCobStatus(cob);
  try {
    const { pix, expiresAt } = pixDataFromCob(provider, cob, merchant);
    return { ...status, providerData: { pix }, expiresAt };
  } catch {
    return status;
  }
}

/** Mapeia o status do registro da cobrança Pix (padrão BACEN) para a situação da tentativa. */
export function mapCobStatus(cob: CobResponse, now: Date = new Date()): ChargeStatusResult {
  switch (cob.status) {
    case 'CONCLUIDA':
      return { status: TransactionStatus.CONFIRMADA, providerStatus: cob.status, payments: paymentsOf(cob) };
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR':
    case 'REMOVIDA_PELO_PSP':
      return { status: TransactionStatus.CANCELADA, providerStatus: cob.status };
    case 'ATIVA': {
      const expiresAt = new Date(new Date(cob.calendario.criacao).getTime() + cob.calendario.expiracao * 1000);
      return { status: expiresAt < now ? TransactionStatus.EXPIRADA : TransactionStatus.PENDENTE, providerStatus: cob.status };
    }
    default:
      return { status: TransactionStatus.PENDENTE, providerStatus: cob.status };
  }
}

function paymentsOf(cob: CobResponse): ProviderPayment[] {
  const received = cob.pix ?? [];
  if (received.length === 0) return [{ amountCents: decimalToCents(cob.valor.original) }];
  return received.map((p) => ({ id: p.endToEndId, amountCents: decimalToCents(p.valor), paidAt: new Date(p.horario) }));
}

/**
 * Cancela uma cobrança Pix. O 400 do PATCH não distingue "já paga" de "já removida",
 * então a classificação vem sempre de uma consulta ao registro.
 */
export async function cancelCob(client: BacenPixClient, txid: string): Promise<CancelResult> {
  try {
    return classifyAfterRemoval(await client.removeCob(txid));
  } catch (err) {
    if (!(err instanceof BankIntegrationError)) throw err;
    if (!(err instanceof BankRejectedError)) return { outcome: 'TECHNICAL_ERROR', error: err };
    try {
      return classifyAfterRemoval(await client.getCob(txid), err.bankMessage);
    } catch (lookupErr) {
      if (lookupErr instanceof BankIntegrationError) return { outcome: 'TECHNICAL_ERROR', error: lookupErr };
      throw lookupErr;
    }
  }
}

function classifyAfterRemoval(cob: CobResponse, reason?: string): CancelResult {
  const current = mapCobStatus(cob);
  if (current.status === TransactionStatus.CONFIRMADA) return { outcome: 'ALREADY_PAID', providerStatus: cob.status, payments: current.payments };
  if (current.status === TransactionStatus.CANCELADA) return { outcome: 'CANCELED', providerStatus: cob.status };
  return { outcome: 'REFUSED', providerStatus: cob.status, reason };
}

const pixWebhookSchema = z.object({ pix: z.array(pixPaymentSchema.extend({ txid: z.string().optional() })) });

/** Webhook padrão BACEN: POST {url}/pix com { pix: [{ endToEndId, txid, valor, horario }] }. */
export function parseBacenPixWebhook(payload: unknown): NormalizedWebhookEvent[] | null {
  const parsed = pixWebhookSchema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data.pix
    .filter((p) => p.txid) // Pix sem txid = recebimento por chave sem cobrança: não é nosso
    .map((p) => ({
      eventKey: `pix:${p.endToEndId}`,
      type: 'PIX_RECEIVED' as const,
      providerReference: p.txid!,
      paymentId: p.endToEndId,
      amountCents: decimalToCents(p.valor),
      occurredAt: new Date(p.horario),
      raw: { endToEndId: p.endToEndId, txid: p.txid, valor: p.valor, horario: p.horario },
    }));
}
