import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app.error';
import { BankIntegrationError } from '../errors/bank.errors';
import { mapError } from '../errors/error-response';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    // Erros do body-parser acontecem antes do middleware de log atribuir o id da requisição.
    const requestId = typeof req.id === 'string' ? req.id : randomUUID();
    if (!res.headersSent && !res.getHeader('x-request-id')) res.setHeader('x-request-id', requestId);

    const mapped = mapError(exception, requestId);
    const logPayload: Record<string, unknown> = {
      msg: 'request failed',
      status: mapped.status,
      code: mapped.body.error.code,
      method: req.method,
      route: req.route?.path ?? 'unmatched',
    };
    if (exception instanceof BankIntegrationError) {
      Object.assign(logPayload, {
        provider: exception.provider,
        operation: exception.operation,
        outcome: exception.outcome,
        bankHttpStatus: exception.bankHttpStatus,
        bankErrorCode: exception.bankErrorCode,
        bankMessage: exception.bankMessage,
      });
    }
    if (exception instanceof AppError && exception.transactionId) {
      logPayload.transactionId = exception.transactionId;
    }

    if (mapped.severity === 'error') {
      this.logger.error({ ...logPayload, err: exception });
    } else {
      this.logger.warn(logPayload);
    }

    if (res.headersSent) return;
    if (exception instanceof AppError && exception.retryable) {
      res.setHeader('Retry-After', '5');
    }
    res.status(mapped.status).json(mapped.body);
  }
}
