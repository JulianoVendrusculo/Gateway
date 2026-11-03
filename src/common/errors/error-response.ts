import { HttpException, HttpStatus } from '@nestjs/common';
import { AppError } from './app.error';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    transactionId?: string;
    requestId?: string;
  };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  /** 5xx e falhas inesperadas são logadas como error; o resto como warn. */
  severity: 'warn' | 'error';
}

const HTTP_CODE_MAP: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

interface BodyParserError {
  type?: string;
  status?: number;
}

/** Converte qualquer erro em um envelope estável — nunca vaza stack/mensagens internas. */
export function mapError(err: unknown, requestId?: string): MappedError {
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      severity: err.httpStatus >= 500 ? 'error' : 'warn',
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && Object.keys(err.details).length > 0 ? { details: err.details } : {}),
          ...(err.transactionId ? { transactionId: err.transactionId } : {}),
          requestId,
        },
      },
    };
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    const response = err.getResponse();
    // ValidationPipe → { message: string[] }
    const messages =
      typeof response === 'object' && response !== null && 'message' in response
        ? (response as { message: unknown }).message
        : undefined;
    const isValidation = status === HttpStatus.BAD_REQUEST && Array.isArray(messages);
    // O Nest converte o SyntaxError do body-parser em BadRequestException com a mensagem crua do parser.
    if (status === HttpStatus.BAD_REQUEST && typeof messages === 'string' && /\bJSON\b/.test(messages)) {
      return badRequest('INVALID_JSON', 'JSON malformado', 400, requestId);
    }
    return {
      status,
      severity: status >= 500 ? 'error' : 'warn',
      body: {
        error: {
          code: isValidation ? 'VALIDATION_ERROR' : (HTTP_CODE_MAP[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR')),
          message: isValidation
            ? 'Payload inválido'
            : status >= 500
              ? 'Erro interno'
              : typeof messages === 'string'
                ? messages
                : err.message,
          ...(isValidation ? { details: { fields: messages } } : {}),
          requestId,
        },
      },
    };
  }

  const bodyParser = err as BodyParserError;
  if (bodyParser?.type === 'entity.parse.failed') {
    return badRequest('INVALID_JSON', 'JSON malformado', 400, requestId);
  }
  if (bodyParser?.type === 'entity.too.large') {
    return badRequest('PAYLOAD_TOO_LARGE', 'Payload excede o tamanho máximo', 413, requestId);
  }

  return {
    status: 500,
    severity: 'error',
    body: { error: { code: 'INTERNAL_ERROR', message: 'Erro interno', requestId } },
  };
}

function badRequest(code: string, message: string, status: number, requestId?: string): MappedError {
  return { status, severity: 'warn', body: { error: { code, message, requestId } } };
}
