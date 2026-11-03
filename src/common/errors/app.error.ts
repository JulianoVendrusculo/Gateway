export type ErrorDetails = Record<string, unknown>;

export interface AppErrorOptions {
  details?: ErrorDetails;
  cause?: unknown;
}

/**
 * Base de todas as exceções de negócio/integração.
 * `code` é estável (contrato da API); `message` é segura para o cliente.
 * Detalhes internos (stack, causa) só vão para o log.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly retryable: boolean = false;
  readonly details?: ErrorDetails;
  private transactionRef?: string;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.details = options.details;
  }

  /**
   * Marca que o erro ocorreu APÓS a transação ser persistida.
   * A camada de idempotência usa isso para gravar a resposta (replay) em vez de liberar a chave.
   */
  attachTransaction(transactionId: string): this {
    this.transactionRef = transactionId;
    return this;
  }

  get transactionId(): string | undefined {
    return this.transactionRef;
  }

  get hasPersistedSideEffects(): boolean {
    return this.transactionRef !== undefined;
  }
}
