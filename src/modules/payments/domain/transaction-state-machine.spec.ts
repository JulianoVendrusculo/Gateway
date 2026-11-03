import { TransactionStatus as S } from '@prisma/client';
import { InvalidStatusTransitionError } from '../../../common/errors';
import { assertTransition, canTransition } from './transaction-state-machine';

describe('transaction state machine', () => {
  it.each([
    [S.PROCESSING, S.PENDING],
    [S.PENDING, S.PAID],
    [S.PENDING, S.EXPIRED],
    [S.AUTHORIZED, S.PAID],
    [S.EXPIRED, S.PAID],
    [S.PAID, S.REFUNDED],
  ])('permite %s -> %s', (from, to) => expect(canTransition(from, to)).toBe(true));

  it.each([
    [S.PAID, S.PENDING],
    [S.FAILED, S.PAID],
    [S.REFUNDED, S.PAID],
    [S.PENDING, S.AUTHORIZED],
    [S.PAID, S.PAID],
  ])('bloqueia %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidStatusTransitionError);
  });
});
