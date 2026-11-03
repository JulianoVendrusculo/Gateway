import { Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { Dispatcher, request } from 'undici';
import {
  BankInvalidResponseError,
  BankIntegrationError,
  BankTimeoutError,
  BankTlsError,
  BankUnavailableError,
} from '../../common/errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BankHttpRequest {
  method: HttpMethod;
  url: string;
  /** Nome lógico da operação (ex.: "pix.cob.create") — usado em logs e erros. */
  operation: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /**
   * Operação idempotente no banco (GET, PUT /cob/{txid}, token)? Se sim, falhas transitórias
   * (5xx/429/timeout) são retentadas. Falhas de conexão (nada enviado) são sempre retentadas.
   */
  idempotent?: boolean;
}

export interface BankHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = unknown>(): T;
}

export interface BankHttpClientOptions {
  provider: string;
  dispatcher: Dispatcher;
  defaultTimeoutMs: number;
  maxRetries?: number;
  maxResponseBytes?: number;
  baseBackoffMs?: number;
}

type TransportClass = 'CONNECT' | 'TLS' | 'TIMEOUT' | 'SOCKET' | 'UNKNOWN';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * Cliente HTTP para APIs bancárias. Cada instância é ligada a um Dispatcher (pool de conexões)
 * configurado com o certificado cliente do convênio (mTLS).
 * - Nunca lança por status HTTP (o adapter interpreta o corpo de erro específico do banco).
 * - Lança BankIntegrationError tipado para falhas de transporte, com semântica de "outcome".
 * - Não loga corpo nem query string (podem conter segredos/PII).
 */
export class BankHttpClient {
  private readonly logger = new Logger(BankHttpClient.name);
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;
  private readonly baseBackoffMs: number;

  constructor(private readonly opts: BankHttpClientOptions) {
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxResponseBytes = opts.maxResponseBytes ?? 5 * 1024 * 1024;
    this.baseBackoffMs = opts.baseBackoffMs ?? 250;
  }

  get provider(): string {
    return this.opts.provider;
  }

  async request(req: BankHttpRequest): Promise<BankHttpResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.once(req, attempt);
        if (req.idempotent && RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        return res;
      } catch (err) {
        const canRetry =
          err instanceof BankIntegrationError &&
          attempt < this.maxRetries &&
          (err.outcome === 'NOT_PROCESSED' ? !(err instanceof BankTlsError) : req.idempotent === true);
        if (!canRetry) throw err;
        this.logger.warn({ msg: 'bank request retry', provider: this.provider, operation: req.operation, attempt, code: (err as BankIntegrationError).code });
        await this.backoff(attempt);
      }
    }
  }

  private async once(req: BankHttpRequest, attempt: number): Promise<BankHttpResponse> {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    let body: string | undefined = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] ??= 'application/json';
    } else if (req.form) {
      body = new URLSearchParams(req.form).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    }

    const timeout = req.timeoutMs ?? this.opts.defaultTimeoutMs;
    const started = performance.now();
    const logBase = { provider: this.provider, operation: req.operation, method: req.method, host: url.host, path: url.pathname, attempt };

    try {
      const res = await request(url, {
        method: req.method,
        headers,
        body,
        dispatcher: this.opts.dispatcher,
        headersTimeout: timeout,
        bodyTimeout: timeout,
        signal: AbortSignal.timeout(timeout + 1000),
      });
      const text = await this.readCapped(res.body, req);
      const durationMs = Math.round(performance.now() - started);
      this.logger.log({ msg: 'bank request', ...logBase, status: res.statusCode, durationMs });
      const provider = this.provider;
      return {
        status: res.statusCode,
        headers: res.headers,
        text,
        json<T>(): T {
          try {
            return JSON.parse(text) as T;
          } catch (cause) {
            throw new BankInvalidResponseError({ provider, operation: req.operation, bankHttpStatus: res.statusCode, cause });
          }
        },
      };
    } catch (err) {
      if (err instanceof BankIntegrationError) throw err;
      const durationMs = Math.round(performance.now() - started);
      const kind = classifyTransportError(err);
      this.logger.warn({ msg: 'bank transport error', ...logBase, durationMs, kind, errorCode: errorCode(err) });
      const ctx = { provider: this.provider, operation: req.operation, cause: err };
      switch (kind) {
        case 'TLS':
          throw new BankTlsError(ctx);
        case 'CONNECT':
          throw new BankUnavailableError(ctx, 'NOT_PROCESSED');
        case 'TIMEOUT':
          throw new BankTimeoutError(ctx);
        default:
          throw new BankUnavailableError(ctx, 'UNCERTAIN');
      }
    }
  }

  private async readCapped(body: AsyncIterable<Buffer> & { destroy?: (err?: Error) => void }, req: BankHttpRequest): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > this.maxResponseBytes) {
        body.destroy?.();
        throw new BankInvalidResponseError({ provider: this.provider, operation: req.operation, bankMessage: 'resposta excede o tamanho máximo' });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = this.baseBackoffMs * 2 ** attempt;
    await sleep(delay + Math.floor(Math.random() * delay));
  }
}

function errorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'ABORT_ERR', 'UND_ERR_ABORTED']);

export function classifyTransportError(err: unknown): TransportClass {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    const name = (e as { name?: unknown }).name;
    const message = String((e as { message?: unknown }).message ?? '');
    if (typeof code === 'string') {
      if (CONNECT_CODES.has(code)) return 'CONNECT';
      if (TIMEOUT_CODES.has(code)) return 'TIMEOUT';
      if (/^ERR_(SSL|TLS)_|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|^EPROTO$/.test(code)) return 'TLS';
    }
    if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT';
    if (/certificate|ssl|tls alert|handshake/i.test(message)) return 'TLS';
    if (typeof code === 'string' && (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'EPIPE')) return 'SOCKET';
  }
  return 'UNKNOWN';
}
