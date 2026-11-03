import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BankAuthenticationError, BankIntegrationError, BankUnavailableError } from '../../../../common/errors';
import { BankHttpClient } from '../../../../infra/http/bank-http-client';
import { isSuccess, parseBankJson, parseBankErrorBody } from './bank-response';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().positive().default(600),
});

export interface TokenRequest {
  http: BankHttpClient;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Deve incluir convênio + versão de credencial + escopo. */
  cacheKey: string;
  /** "basic": credenciais no header Authorization (RFC 6749 §2.3.1); "body": no form. */
  authStyle?: 'basic' | 'body';
  query?: Record<string, string>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * OAuth2 client_credentials com cache em memória e single-flight
 * (requisições concorrentes compartilham a mesma emissão de token).
 */
@Injectable()
export class OAuth2TokenProvider {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();

  async getToken(req: TokenRequest, forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = this.cache.get(req.cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.token;
    }
    const pending = this.inflight.get(req.cacheKey);
    if (pending) return pending;

    const promise = this.fetchToken(req).finally(() => this.inflight.delete(req.cacheKey));
    this.inflight.set(req.cacheKey, promise);
    return promise;
  }

  invalidate(cacheKey: string): void {
    this.cache.delete(cacheKey);
  }

  private async fetchToken(req: TokenRequest): Promise<string> {
    const operation = 'oauth.token';
    const form: Record<string, string> = { grant_type: 'client_credentials' };
    if (req.scope) form.scope = req.scope;
    const headers: Record<string, string> = {};
    if ((req.authStyle ?? 'basic') === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${req.clientId}:${req.clientSecret}`).toString('base64')}`;
    } else {
      form.client_id = req.clientId;
      form.client_secret = req.clientSecret;
    }

    let res;
    try {
      res = await req.http.request({ method: 'POST', url: req.tokenUrl, operation, form, headers, query: req.query, idempotent: true });
    } catch (err) {
      // Sem token, a cobrança ainda não foi enviada: o resultado nunca é "incerto".
      // Em TLS 1.3 a rejeição do certificado cliente chega como conexão encerrada sem resposta.
      if (err instanceof BankIntegrationError && err.outcome === 'UNCERTAIN') {
        throw new BankUnavailableError(
          { provider: req.http.provider, operation, cause: err, bankMessage: 'conexão encerrada ao obter token (verifique o certificado mTLS do convênio)' },
          'NOT_PROCESSED',
        );
      }
      throw err;
    }
    if (!isSuccess(res)) {
      const parsed = parseBankErrorBody(res.text);
      // Qualquer falha na emissão de token é tratada como problema de credencial do convênio.
      throw new BankAuthenticationError({
        provider: req.http.provider,
        operation,
        bankHttpStatus: res.status,
        bankErrorCode: parsed.code,
        bankMessage: parsed.message,
      });
    }
    const body = parseBankJson(req.http.provider, operation, res, tokenSchema);
    const ttlMs = Math.max(30, body.expires_in - 60) * 1000; // margem contra relógio/latência
    this.cache.set(req.cacheKey, { token: body.access_token, expiresAt: Date.now() + ttlMs });
    return body.access_token;
  }
}
