import { Transform } from 'class-transformer';
import { ValidationOptions, registerDecorator } from 'class-validator';
import { normalizeDocument, sanitizeText } from '../utils/text';
import { detectDocumentType } from './brazilian-document';

/** Aplica sanitizeText em strings (trim, NFC, remove controle/invisíveis). */
export function Sanitize(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? sanitizeText(value) : value));
}

/** Remove pontuação de CPF/CNPJ antes da validação. */
export function NormalizeDocument(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? normalizeDocument(value) : value));
}

export function IsBrazilianDocument(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isBrazilianDocument',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: { message: '$property deve ser um CPF ou CNPJ válido', ...options },
      validator: { validate: (value: unknown) => typeof value === 'string' && detectDocumentType(value) !== null },
    });
}

const METADATA_MAX_KEYS = 20;
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const METADATA_MAX_VALUE = 500;

/** Metadata livre do lojista: no máximo 20 chaves, valores string/number/boolean curtos. */
export function IsMetadataRecord(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isMetadataRecord',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: {
        message: `$property deve ser um objeto plano com até ${METADATA_MAX_KEYS} chaves [A-Za-z0-9_.-] e valores primitivos de até ${METADATA_MAX_VALUE} caracteres`,
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
          if (Object.getPrototypeOf(value) !== Object.prototype) return false;
          const entries = Object.entries(value);
          if (entries.length > METADATA_MAX_KEYS) return false;
          return entries.every(
            ([k, v]) =>
              METADATA_KEY.test(k) &&
              (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= METADATA_MAX_VALUE)),
          );
        },
      },
    });
}

/** Número de cartão válido pelo algoritmo de Luhn (13–19 dígitos). */
export function IsLuhnValid(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isLuhnValid',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: { message: '$property inválido', ...options },
      validator: { validate: (value: unknown) => typeof value === 'string' && isLuhnValid(value) },
    });
}

export function isLuhnValid(pan: string): boolean {
  if (!/^\d{13,19}$/.test(pan)) return false;
  let sum = 0;
  let double = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = pan.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
