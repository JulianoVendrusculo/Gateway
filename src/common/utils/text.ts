// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g;

/** Sanitização genérica de entrada: NFC, remove caracteres de controle/invisíveis, colapsa espaços. */
export function sanitizeText(value: string): string {
  return value.normalize('NFC').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

export function removeAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Texto aceito com segurança pelos layouts bancários (boleto/CNAB/SOAP):
 * ASCII maiúsculo, sem acentos, apenas [A-Z0-9 .,/-()], truncado.
 */
export function toBankSafeText(value: string | undefined | null, maxLength: number): string {
  if (!value) return '';
  return removeAccents(sanitizeText(value))
    .toUpperCase()
    .replace(/[^A-Z0-9 .,/\-()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Normaliza documento: remove pontuação e deixa maiúsculo (CNPJ alfanumérico). */
export function normalizeDocument(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function maskDocument(document: string): string {
  if (document.length === 11) return `***.${document.slice(3, 6)}.${document.slice(6, 9)}-**`;
  if (document.length === 14) return `**.${document.slice(2, 5)}.${document.slice(5, 8)}/****-**`;
  return '***';
}

/** Mascara segredos para exibição administrativa: "abcd…wxyz". */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
