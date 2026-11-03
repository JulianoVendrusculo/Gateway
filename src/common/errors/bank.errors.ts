import { AppError } from './app.error';

/**
 * Resultado da operação no banco, do ponto de vista de consistência:
 *  - NOT_PROCESSED: garantidamente não processada (ex.: falha de TLS/autenticação) → pode marcar FAILED.
 *  - REJECTED: o banco recusou explicitamente (regra de negócio)                    → FAILED.
 *  - UNCERTAIN: pode ter sido processada (timeout, 5xx, conexão caída após envio)  → manter PROCESSING e reconciliar.
 */
export type BankOperationOutcome = 'NOT_PROCESSED' | 'REJECTED' | 'UNCERTAIN';

export interface BankErrorContext {
  provider: string;
  operation: string;
  bankHttpStatus?: number;
  bankErrorCode?: string;
  bankMessage?: string;
  cause?: unknown;
}

const MAX_BANK_MESSAGE = 300;

export abstract class BankIntegrationError extends AppError {
  abstract readonly outcome: BankOperationOutcome;
  readonly provider: string;
  readonly operation: string;
  readonly bankHttpStatus?: number;
  readonly bankErrorCode?: string;
  readonly bankMessage?: string;

  constructor(message: string, ctx: BankErrorContext, exposeBankMessage = false) {
    const bankMessage = ctx.bankMessage?.replace(/\s+/g, ' ').trim().slice(0, MAX_BANK_MESSAGE);
    super(message, {
      cause: ctx.cause,
      details: {
        provider: ctx.provider,
        operation: ctx.operation,
        ...(ctx.bankErrorCode ? { bankErrorCode: ctx.bankErrorCode } : {}),
        ...(exposeBankMessage && bankMessage ? { bankMessage } : {}),
      },
    });
    this.provider = ctx.provider;
    this.operation = ctx.operation;
    this.bankHttpStatus = ctx.bankHttpStatus;
    this.bankErrorCode = ctx.bankErrorCode;
    this.bankMessage = bankMessage;
  }
}

export class BankAuthenticationError extends BankIntegrationError {
  readonly code = 'BANK_AUTHENTICATION_FAILED';
  readonly httpStatus = 502;
  readonly outcome = 'NOT_PROCESSED' as const;
  constructor(ctx: BankErrorContext) {
    super('Falha de autenticação com o banco (verifique credenciais/certificado do convênio)', ctx);
  }
}

export class BankRejectedError extends BankIntegrationError {
  readonly code = 'BANK_REJECTED';
  readonly httpStatus = 422;
  readonly outcome = 'REJECTED' as const;
  constructor(ctx: BankErrorContext) {
    super('A operação foi recusada pelo banco', ctx, true);
  }
}

export class BankRateLimitedError extends BankIntegrationError {
  readonly code = 'BANK_RATE_LIMITED';
  readonly httpStatus = 503;
  readonly outcome = 'NOT_PROCESSED' as const;
  override readonly retryable = true;
  constructor(ctx: BankErrorContext) {
    super('Limite de requisições do banco atingido; tente novamente em instantes', ctx);
  }
}

export class BankUnavailableError extends BankIntegrationError {
  readonly code = 'BANK_UNAVAILABLE';
  readonly httpStatus = 503;
  override readonly retryable = true;
  readonly outcome: BankOperationOutcome;
  constructor(ctx: BankErrorContext, outcome: 'NOT_PROCESSED' | 'UNCERTAIN') {
    super('O banco está indisponível no momento', ctx);
    this.outcome = outcome;
  }
}

export class BankTimeoutError extends BankIntegrationError {
  readonly code = 'BANK_TIMEOUT';
  readonly httpStatus = 504;
  readonly outcome = 'UNCERTAIN' as const;
  override readonly retryable = true;
  constructor(ctx: BankErrorContext) {
    super('Tempo de resposta do banco excedido; o status será reconciliado automaticamente', ctx);
  }
}

export class BankTlsError extends BankIntegrationError {
  readonly code = 'BANK_TLS_ERROR';
  readonly httpStatus = 502;
  readonly outcome = 'NOT_PROCESSED' as const;
  constructor(ctx: BankErrorContext) {
    super('Falha no handshake mTLS com o banco (certificado cliente/CA)', ctx);
  }
}

export class BankInvalidResponseError extends BankIntegrationError {
  readonly code = 'BANK_INVALID_RESPONSE';
  readonly httpStatus = 502;
  readonly outcome = 'UNCERTAIN' as const;
  constructor(ctx: BankErrorContext) {
    super('Resposta inesperada do banco; o status será reconciliado automaticamente', ctx);
  }
}
