/** Limite operacional por transação: R$ 10.000.000,00 (cabe com folga em INT4 de centavos). */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

export function assertValidCents(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) {
    throw new RangeError(`Valor em centavos inválido: ${cents}`);
  }
}

/** 15000 -> "150.00" (sem aritmética de ponto flutuante). */
export function centsToDecimalString(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`centavos inválidos: ${cents}`);
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** "150.00" | "150.5" | "150" | 150.5 -> 15050 (parse exato, sem float). */
export function decimalToCents(value: string | number): number {
  const str = typeof value === 'number' ? value.toFixed(2) : value.trim().replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (!match) throw new RangeError(`valor decimal inválido: ${String(value)}`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new RangeError(`valor fora do intervalo: ${String(value)}`);
  return cents;
}
