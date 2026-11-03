import { normalizeDocument } from '../utils/text';

export type BrazilianDocumentType = 'CPF' | 'CNPJ';

export function isValidCpf(raw: string): boolean {
  const cpf = raw.replace(/\D/g, '');
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digits = cpf.split('').map(Number);
  const calc = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i] * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === digits[9] && calc(10) === digits[10];
}

/**
 * Valida CNPJ numérico e alfanumérico (IN RFB nº 2.229/2024, emissão a partir de jul/2026):
 * 12 posições [0-9A-Z] + 2 DVs numéricos; cada caractere vale (charCode - 48).
 */
export function isValidCnpj(raw: string): boolean {
  const cnpj = normalizeDocument(raw);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const values = cnpj.split('').map((c) => c.charCodeAt(0) - 48);
  const calc = (len: number): number => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + values[i] * w, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return calc(12) === values[12] && calc(13) === values[13];
}

export function detectDocumentType(raw: string): BrazilianDocumentType | null {
  const doc = normalizeDocument(raw);
  if (doc.length === 11 && isValidCpf(doc)) return 'CPF';
  if (doc.length === 14 && isValidCnpj(doc)) return 'CNPJ';
  return null;
}

export function isNumericDocument(doc: string): boolean {
  return /^\d+$/.test(doc);
}
