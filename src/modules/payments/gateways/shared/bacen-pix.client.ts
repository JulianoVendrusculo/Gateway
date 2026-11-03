import { TransactionStatus } from '@prisma/client';
import { z } from 'zod';
import { decimalToCents } from '../../../../common/utils/money';
import { BankHttpClient, BankHttpResponse, HttpMethod } from '../../../../infra/http/bank-http-client';
import { BankInvalidResponseError } from '../../../../common/errors';
import { ChargeStatusResult, NormalizedWebhookEvent, PixData } from '../../domain/payment-gateway.port';
import { buildDynamicPixBrCode, isValidBrCode } from '../../pix/pix-brcode';
import { authorizedRequest, TokenSupplier } from './authorized-request';
import { parseBankJson } from './bank-response';

// API Pix padronizada pelo BACEN (https://bacen.github.io/pix-api) — implementada por todos os PSPs.

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

/** Mapeia o status da cobrança Pix (padrão BACEN) para o status do gateway. */
export function mapCobStatus(cob: CobResponse, now: Date = new Date()): ChargeStatusResult {
  switch (cob.status) {
    case 'CONCLUIDA': {
      const payments = cob.pix ?? [];
      const paid = payments.length > 0 ? payments.reduce((sum, p) => sum + decimalToCents(p.valor), 0) : decimalToCents(cob.valor.original);
      return {
        status: TransactionStatus.PAID,
        providerStatus: cob.status,
        paidAmountCents: paid,
        paidAt: payments[0] ? new Date(payments[0].horario) : now,
      };
    }
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR':
    case 'REMOVIDA_PELO_PSP':
      return { status: TransactionStatus.CANCELED, providerStatus: cob.status };
    case 'ATIVA': {
      const expiresAt = new Date(new Date(cob.calendario.criacao).getTime() + cob.calendario.expiracao * 1000);
      return { status: expiresAt < now ? TransactionStatus.EXPIRED : TransactionStatus.PENDING, providerStatus: cob.status };
    }
    default:
      return { status: TransactionStatus.PENDING, providerStatus: cob.status };
  }
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
      amountCents: decimalToCents(p.valor),
      occurredAt: new Date(p.horario),
      raw: { endToEndId: p.endToEndId, txid: p.txid, valor: p.valor, horario: p.horario },
    }));
}
