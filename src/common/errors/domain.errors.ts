import { AppError, AppErrorOptions } from './app.error';

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
}

export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHORIZED';
  readonly httpStatus = 401;
  constructor(message = 'Credenciais inválidas ou ausentes') {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
}

export class ResourceNotFoundError extends AppError {
  readonly code = 'RESOURCE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(resource: string) {
    super(`${resource} não encontrado(a)`);
  }
}

export class ConflictError extends AppError {
  readonly code: string = 'CONFLICT';
  readonly httpStatus = 409;
}

export class ConvenioNotFoundError extends AppError {
  readonly code = 'CONVENIO_NOT_AVAILABLE';
  readonly httpStatus = 422;
  constructor(method: string, convenioId?: string) {
    super(
      convenioId
        ? `Convênio ${convenioId} não encontrado, inativo ou sem suporte a ${method}`
        : `Nenhum convênio ativo habilitado para ${method}`,
      { details: { method, convenioId } },
    );
  }
}

/** Convênio cadastrado com dados inválidos (rejeitado no cadastro). */
export class ConvenioValidationError extends AppError {
  readonly code = 'CONVENIO_INVALID';
  readonly httpStatus = 422;
}

/** Convênio existente que não pode ser usado em runtime (ex.: certificado expirado). */
export class ConvenioMisconfiguredError extends AppError {
  readonly code = 'CONVENIO_MISCONFIGURED';
  readonly httpStatus = 503;
  constructor(convenioId: string, reason: string, options: AppErrorOptions = {}) {
    super('Convênio do lojista está com configuração inválida para esta operação', {
      ...options,
      details: { convenioId, reason, ...options.details },
    });
  }
}

export class UnsupportedPaymentMethodError extends AppError {
  readonly code = 'PAYMENT_METHOD_NOT_SUPPORTED';
  readonly httpStatus = 422;
  constructor(provider: string, method: string) {
    super(`O provedor ${provider} não suporta o método ${method}`, { details: { provider, method } });
  }
}

export class InvalidStatusTransitionError extends AppError {
  readonly code = 'INVALID_STATUS_TRANSITION';
  readonly httpStatus = 409;
  constructor(from: string, to: string) {
    super(`Transição de status inválida: ${from} -> ${to}`, { details: { from, to } });
  }
}

export class ConcurrentModificationError extends ConflictError {
  override readonly code = 'CONCURRENT_MODIFICATION';
  constructor(resource: string) {
    super(`${resource} foi modificado(a) concorrentemente; tente novamente`);
  }
}

// ---------------------------------------------------------------------------
// v2 — cobrança única. Os três primeiros códigos são contrato com o front.
// ---------------------------------------------------------------------------

/** A cobrança já foi paga: nenhuma nova tentativa é criada. */
export class PaymentAlreadyConfirmedError extends ConflictError {
  override readonly code = 'PAGAMENTO_JA_CONFIRMADO';
  constructor(details: { chargeId: string; paidTransactionId: string | null }) {
    super('Esta cobrança já foi paga', { details });
  }
}

/**
 * Existe uma tentativa que ainda não pode ser substituída: em criação, em verificação
 * depois do vencimento, ou com troca de método em andamento. O front deve aguardar e consultar a cobrança.
 */
export class AttemptInProgressError extends ConflictError {
  override readonly code = 'TENTATIVA_EM_ANDAMENTO';
  override readonly retryable = true;
  constructor(details: { reason: string; transactionId?: string; status?: string; method?: string; until?: string | null }) {
    super('Há uma tentativa de pagamento em andamento para esta cobrança', { details });
  }
}

/** A tentativa ativa não pôde ser cancelada no banco, então a troca de método fica bloqueada. */
export class CancellationRefusedError extends ConflictError {
  override readonly code = 'CANCELAMENTO_RECUSADO';
  constructor(details: { reason: string; transactionId: string; method: string; activeUntil: string | null; limitation?: boolean }) {
    super('A tentativa de pagamento atual não pôde ser cancelada; a troca de método está bloqueada', { details });
  }
}

/** O valor informado difere do valor da cobrança já aberta para a mesma inscrição. */
export class ChargeAmountMismatchError extends AppError {
  readonly code = 'COBRANCA_VALOR_DIVERGENTE';
  readonly httpStatus = 422;
  constructor(details: { chargeId: string; chargeAmount: number; requestedAmount: number }) {
    super('O valor informado é diferente do valor da cobrança desta inscrição', { details });
  }
}

/** A cobrança foi cancelada ou expirou: não aceita novas tentativas. */
export class ChargeClosedError extends ConflictError {
  override readonly code = 'COBRANCA_ENCERRADA';
  constructor(details: { chargeId: string; status: string }) {
    super('Esta cobrança está encerrada e não aceita novas tentativas de pagamento', { details });
  }
}

export class IdempotencyKeyRequiredError extends AppError {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  readonly httpStatus = 400;
  constructor() {
    super('O header Idempotency-Key é obrigatório para esta operação');
  }
}

export class IdempotencyKeyInvalidError extends AppError {
  readonly code = 'IDEMPOTENCY_KEY_INVALID';
  readonly httpStatus = 400;
  constructor() {
    super('Idempotency-Key deve ter de 8 a 128 caracteres [A-Za-z0-9_-:.]');
  }
}

export class IdempotencyKeyReusedError extends AppError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = 422;
  constructor() {
    super('Esta Idempotency-Key já foi usada com um payload diferente');
  }
}

export class IdempotencyInProgressError extends AppError {
  readonly code = 'IDEMPOTENCY_REQUEST_IN_PROGRESS';
  readonly httpStatus = 409;
  override readonly retryable = true;
  constructor() {
    super('Uma requisição com esta Idempotency-Key ainda está em processamento');
  }
}

/**
 * Falha de integridade/decifragem. O motivo fica em `reason`, que vai para o log junto do erro;
 * `details` (que o cliente recebe) fica vazio para não revelar o estado do chaveiro.
 */
export class CryptoIntegrityError extends AppError {
  readonly code = 'INTERNAL_ERROR';
  readonly httpStatus = 500;
  constructor(
    readonly reason: string,
    options: AppErrorOptions = {},
  ) {
    super('Erro interno', { cause: options.cause });
  }
}

/** Erro inesperado após efeitos colaterais — preserva o transactionId para o cliente consultar depois. */
export class UnexpectedProcessingError extends AppError {
  readonly code = 'INTERNAL_ERROR';
  readonly httpStatus = 500;
  constructor(options: AppErrorOptions = {}) {
    super('Erro interno ao processar a cobrança; o status será reconciliado automaticamente', options);
  }
}
