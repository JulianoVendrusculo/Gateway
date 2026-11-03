import { diffInDays, parseIsoDate } from '../../../common/utils/date-helpers';

// Especificação FEBRABAN — boleto de cobrança (código de barras 44 posições / linha digitável 47).
// Barras: BBB M D FFFF VVVVVVVVVV LLLLLLLLLLLLLLLLLLLLLLLLL
//   BBB banco | M moeda (9=Real) | D DV geral (mód. 11) | FFFF fator vencimento | V valor (10) | L campo livre (25)

const FACTOR_BASE = parseIsoDate('1997-10-07');

export function mod10(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    let p = Number(digits[i]) * weight;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/** DV geral do código de barras (mód. 11, pesos 2..9; resultados 0, 10, 11 => 1). */
export function barcodeCheckDigit(digits43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits43.length - 1; i >= 0; i--) {
    sum += Number(digits43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/**
 * Fator de vencimento: dias desde 07/10/1997. Ao atingir 9999 (21/02/2025) o fator
 * reinicia em 1000 (22/02/2025), conforme comunicado FEBRABAN.
 */
export function dueDateFactor(dueDate: Date): string {
  const days = diffInDays(FACTOR_BASE, dueDate);
  if (days < 1000) throw new RangeError('data de vencimento anterior à faixa suportada');
  return (((days - 1000) % 9000) + 1000).toString().padStart(4, '0');
}

export interface BarcodeInput {
  bankCode: string;
  dueDate: Date;
  amountCents: number;
  freeField: string;
}

export function buildBarcode(input: BarcodeInput): string {
  if (!/^\d{3}$/.test(input.bankCode)) throw new RangeError('código do banco inválido');
  if (!/^\d{25}$/.test(input.freeField)) throw new RangeError('campo livre deve ter 25 dígitos');
  const amount = input.amountCents.toString().padStart(10, '0');
  if (amount.length > 10) throw new RangeError('valor excede o limite do código de barras');
  const without = `${input.bankCode}9${dueDateFactor(input.dueDate)}${amount}${input.freeField}`;
  const dv = barcodeCheckDigit(without);
  return `${without.slice(0, 4)}${dv}${without.slice(4)}`;
}

export function isValidBarcode(barcode: string): boolean {
  if (!/^\d{44}$/.test(barcode)) return false;
  return barcodeCheckDigit(barcode.slice(0, 4) + barcode.slice(5)) === Number(barcode[4]);
}

export function barcodeToDigitableLine(barcode: string): string {
  if (!/^\d{44}$/.test(barcode)) throw new RangeError('código de barras deve ter 44 dígitos');
  const free = barcode.slice(19);
  const f1 = barcode.slice(0, 4) + free.slice(0, 5);
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${barcode[4]}${barcode.slice(5, 19)}`;
}

export function digitableLineToBarcode(line: string): string {
  const d = line.replace(/\D/g, '');
  if (d.length !== 47) throw new RangeError('linha digitável deve ter 47 dígitos');
  return d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
}

export function isValidDigitableLine(line: string): boolean {
  const d = line.replace(/\D/g, '');
  if (d.length !== 47) return false;
  const fieldsOk =
    mod10(d.slice(0, 9)) === Number(d[9]) &&
    mod10(d.slice(10, 20)) === Number(d[20]) &&
    mod10(d.slice(21, 31)) === Number(d[31]);
  return fieldsOk && isValidBarcode(digitableLineToBarcode(d));
}

/** "AAABC.CCCCX DDDDD.DDDDDY EEEEE.EEEEEZ K UUUUVVVVVVVVVV" */
export function formatDigitableLine(line: string): string {
  const d = line.replace(/\D/g, '');
  return `${d.slice(0, 5)}.${d.slice(5, 10)} ${d.slice(10, 15)}.${d.slice(15, 21)} ${d.slice(21, 26)}.${d.slice(26, 32)} ${d[32]} ${d.slice(33)}`;
}
