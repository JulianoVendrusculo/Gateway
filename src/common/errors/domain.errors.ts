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

/** Falha de integridade/decifragem — nunca expõe detalhes ao cliente. */
export class CryptoIntegrityError extends AppError {
  readonly code = 'INTERNAL_ERROR';
  readonly httpStatus = 500;
  constructor(reason: string, options: AppErrorOptions = {}) {
    super('Erro interno', { ...options, details: { reason } });
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
