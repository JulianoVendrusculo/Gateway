import { TransactionStatus } from '@prisma/client';
import { InvalidStatusTransitionError } from '../../../common/errors';

const S = TransactionStatus;

/** Status da v2. Os da v1 (PENDING, PAID...) só existem em linhas legadas e não transitam. */
export type AttemptStatus = Extract<
  TransactionStatus,
  'PENDENTE' | 'PROCESSANDO' | 'EM_VERIFICACAO' | 'CONFIRMADA' | 'CANCELADA' | 'EXPIRADA' | 'FALHOU' | 'PAGO_DUPLICADO'
>;

/**
 * Tentativa ATIVA: ainda pode resultar em pagamento e, por isso, bloqueia a Charge.
 * O banco de dados garante no máximo uma por Charge (índice único parcial).
 */
export const ACTIVE_STATUSES: readonly AttemptStatus[] = [S.PENDENTE, S.PROCESSANDO, S.EM_VERIFICACAO];

/** Status em que o provedor ainda pode mudar o desfecho — inclusive pagamento tardio de tentativa encerrada. */
export const SYNCABLE_STATUSES: readonly AttemptStatus[] = [...ACTIVE_STATUSES, S.CANCELADA, S.EXPIRADA, S.FALHOU];

const TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  [S.PROCESSANDO]: [S.PENDENTE, S.CONFIRMADA, S.FALHOU, S.CANCELADA, S.EXPIRADA, S.EM_VERIFICACAO, S.PAGO_DUPLICADO],
  [S.PENDENTE]: [S.CONFIRMADA, S.CANCELADA, S.EM_VERIFICACAO, S.EXPIRADA, S.PAGO_DUPLICADO],
  [S.EM_VERIFICACAO]: [S.CONFIRMADA, S.EXPIRADA, S.CANCELADA, S.PAGO_DUPLICADO],
  // Pagamento depois do cancelamento ou da expiração acontece (boleto compensado no dia seguinte,
  // confirmação de cartão atrasada). O dinheiro entrou e não pode se perder: ou quita a Charge,
  // ou vira PAGO_DUPLICADO com pendência de estorno.
  [S.CANCELADA]: [S.CONFIRMADA, S.PAGO_DUPLICADO],
  [S.EXPIRADA]: [S.CONFIRMADA, S.PAGO_DUPLICADO],
  [S.FALHOU]: [S.CONFIRMADA, S.PAGO_DUPLICADO],
  [S.CONFIRMADA]: [],
  [S.PAGO_DUPLICADO]: [],
};

export function isAttemptStatus(status: TransactionStatus): status is AttemptStatus {
  return status in TRANSITIONS;
}

export function isActive(status: TransactionStatus): boolean {
  return (ACTIVE_STATUSES as readonly TransactionStatus[]).includes(status);
}

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return isAttemptStatus(from) && isAttemptStatus(to) && TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransition(from, to)) throw new InvalidStatusTransitionError(from, to);
}
