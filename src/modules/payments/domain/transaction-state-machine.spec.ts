import { TransactionStatus as S } from '@prisma/client';
import { InvalidStatusTransitionError } from '../../../common/errors';
import { ACTIVE_STATUSES, assertTransition, canTransition, isActive } from './transaction-state-machine';

describe('máquina de estados da tentativa (v2)', () => {
  it.each([
    [S.PROCESSANDO, S.PENDENTE],
    [S.PROCESSANDO, S.FALHOU],
    [S.PENDENTE, S.CONFIRMADA],
    [S.PENDENTE, S.CANCELADA],
    [S.PENDENTE, S.EM_VERIFICACAO],
    [S.EM_VERIFICACAO, S.CONFIRMADA],
    [S.EM_VERIFICACAO, S.EXPIRADA],
  ])('permite %s -> %s', (from, to) => expect(canTransition(from, to)).toBe(true));

  it.each([
    [S.CANCELADA, S.CONFIRMADA],
    [S.EXPIRADA, S.CONFIRMADA],
    [S.CANCELADA, S.PAGO_DUPLICADO],
    [S.EXPIRADA, S.PAGO_DUPLICADO],
    [S.PENDENTE, S.PAGO_DUPLICADO],
  ])('pagamento tardio nunca se perde: %s -> %s', (from, to) => expect(canTransition(from, to)).toBe(true));

  it.each([
    [S.CONFIRMADA, S.PENDENTE],
    [S.CONFIRMADA, S.CANCELADA],
    [S.CONFIRMADA, S.PAGO_DUPLICADO],
    [S.PAGO_DUPLICADO, S.CONFIRMADA],
    [S.EXPIRADA, S.PENDENTE],
    [S.CANCELADA, S.PENDENTE],
    [S.EM_VERIFICACAO, S.PENDENTE],
    [S.PENDENTE, S.PENDENTE],
  ])('bloqueia %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidStatusTransitionError);
  });

  it('status da v1 não transitam: a v2 nunca os grava nem os altera', () => {
    expect(canTransition(S.PENDING, S.PAID)).toBe(false);
    expect(canTransition(S.PENDING, S.CONFIRMADA)).toBe(false);
    expect(canTransition(S.PENDENTE, S.PAID)).toBe(false);
  });

  it('só PENDENTE, PROCESSANDO e EM_VERIFICACAO bloqueiam a cobrança', () => {
    expect(ACTIVE_STATUSES).toEqual([S.PENDENTE, S.PROCESSANDO, S.EM_VERIFICACAO]);
    expect([S.CONFIRMADA, S.CANCELADA, S.EXPIRADA, S.FALHOU, S.PAGO_DUPLICADO, S.PENDING].some(isActive)).toBe(false);
  });
});
