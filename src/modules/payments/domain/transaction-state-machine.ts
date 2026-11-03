import { TransactionStatus } from '@prisma/client';
import { InvalidStatusTransitionError } from '../../../common/errors';

const S = TransactionStatus;

const TRANSITIONS: Readonly<Record<TransactionStatus, readonly TransactionStatus[]>> = {
  [S.PROCESSING]: [S.PENDING, S.AUTHORIZED, S.PAID, S.FAILED, S.CANCELED, S.EXPIRED],
  [S.PENDING]: [S.PAID, S.CANCELED, S.EXPIRED, S.FAILED],
  [S.AUTHORIZED]: [S.PAID, S.CANCELED],
  // Pagamento após expiração/cancelamento pode ocorrer (ex.: Pix pago no limite, boleto pago após baixa).
  // O dinheiro entrou: registramos PAID para não perder conciliação financeira.
  [S.EXPIRED]: [S.PAID],
  [S.CANCELED]: [S.PAID],
  [S.PAID]: [S.REFUNDED],
  [S.FAILED]: [],
  [S.REFUNDED]: [],
};

export const TERMINAL_STATUSES: ReadonlySet<TransactionStatus> = new Set([S.FAILED, S.REFUNDED]);

/** Status que ainda dependem de confirmação do provedor (alvo da reconciliação). */
export const OPEN_STATUSES: readonly TransactionStatus[] = [S.PROCESSING, S.PENDING, S.AUTHORIZED];

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransition(from, to)) throw new InvalidStatusTransitionError(from, to);
}
