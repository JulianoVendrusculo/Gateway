import { ZodTypeAny, z } from 'zod';
import {
  BankAuthenticationError,
  BankIntegrationError,
  BankInvalidResponseError,
  BankRateLimitedError,
  BankRejectedError,
  BankUnavailableError,
} from '../../../../common/errors';
import { BankHttpResponse } from '../../../../infra/http/bank-http-client';

export interface ParsedBankError {
  code?: string;
  message?: string;
}

/**
 * Extrai código/mensagem dos formatos de erro mais comuns:
 *  - API Pix BACEN (RFC 7807): { type, title, detail, violacoes: [{ razao, propriedade }] }
 *  - BB: { erros: [{ codigo, mensagem }] } | { errors: [{ code, message }] }
 *  - OAuth2: { error, error_description }
 */
export function parseBankErrorBody(text: string): ParsedBankError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) || undefined };
  }
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;

  const list = (b.erros ?? b.errors) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(list) && list.length > 0) {
    const first = list[0];
    return {
      code: str(first.codigo ?? first.code),
      message: list.map((e) => str(e.mensagem ?? e.message ?? e.textoMensagem)).filter(Boolean).join('; '),
    };
  }
  if (typeof b.error === 'string') return { code: b.error, message: str(b.error_description) };
  if (b.title || b.detail || b.type) {
    const violations = Array.isArray(b.violacoes)
      ? (b.violacoes as Array<Record<string, unknown>>).map((v) => `${str(v.propriedade) ?? ''} ${str(v.razao) ?? ''}`.trim())
      : [];
    return {
      code: str(b.type)?.split('/').pop() ?? str(b.title),
      message: [str(b.detail) ?? str(b.title), ...violations].filter(Boolean).join('; '),
    };
  }
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
}

/** Converte resposta HTTP não-2xx em exceção tipada. */
export function toBankError(provider: string, operation: string, res: BankHttpResponse, parsed?: ParsedBankError): BankIntegrationError {
  const p = parsed ?? parseBankErrorBody(res.text);
  const ctx = { provider, operation, bankHttpStatus: res.status, bankErrorCode: p.code, bankMessage: p.message };
  if (res.status === 401 || res.status === 403) return new BankAuthenticationError(ctx);
  if (res.status === 429) return new BankRateLimitedError(ctx);
  if (res.status >= 500) return new BankUnavailableError(ctx, 'UNCERTAIN');
  if (res.status >= 400) return new BankRejectedError(ctx);
  return new BankInvalidResponseError(ctx);
}

export function isSuccess(res: BankHttpResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

/** Valida o corpo de sucesso contra um schema — resposta fora do contrato vira BankInvalidResponseError. */
export function parseBankJson<S extends ZodTypeAny>(provider: string, operation: string, res: BankHttpResponse, schema: S): z.output<S> {
  const parsed = schema.safeParse(res.json());
  if (!parsed.success) {
    throw new BankInvalidResponseError({
      provider,
      operation,
      bankHttpStatus: res.status,
      bankMessage: `contrato inesperado: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    });
  }
  return parsed.data as z.output<S>;
}
