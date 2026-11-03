import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BankRejectedError, BankTimeoutError, IdempotencyKeyReusedError } from './index';
import { mapError } from './error-response';

describe('mapError', () => {
  it('erro de banco expõe código estável, detalhes seguros e transactionId', () => {
    const err = new BankRejectedError({ provider: 'BB', operation: 'boleto.create', bankHttpStatus: 400, bankErrorCode: '123', bankMessage: 'CEP inválido' }).attachTransaction('tx-1');
    expect(mapError(err, 'req-1')).toEqual({
      status: 422,
      severity: 'warn',
      body: { error: { code: 'BANK_REJECTED', message: expect.any(String), details: { provider: 'BB', operation: 'boleto.create', bankErrorCode: '123', bankMessage: 'CEP inválido' }, transactionId: 'tx-1', requestId: 'req-1' } },
    });
  });

  it('timeout é 504 e não expõe mensagem interna do banco', () => {
    const mapped = mapError(new BankTimeoutError({ provider: 'BB', operation: 'pix', bankMessage: 'stack interna' }));
    expect(mapped.status).toBe(504);
    expect(JSON.stringify(mapped.body)).not.toContain('stack interna');
  });

  it('padroniza validação, JSON malformado e 404', () => {
    expect(mapError(new BadRequestException(['amount must be an integer'])).body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: ['amount must be an integer'] } });
    expect(mapError(new BadRequestException('Unexpected end of JSON input')).body.error).toMatchObject({ code: 'INVALID_JSON', message: 'JSON malformado' });
    expect(mapError(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
    expect(mapError(new IdempotencyKeyReusedError()).status).toBe(422);
  });

  it('erro desconhecido vira 500 genérico', () => {
    const mapped = mapError(new Error('senha do banco: 123'));
    expect(mapped).toMatchObject({ status: 500, severity: 'error', body: { error: { code: 'INTERNAL_ERROR', message: 'Erro interno' } } });
    expect(JSON.stringify(mapped.body)).not.toContain('senha');
  });
});
