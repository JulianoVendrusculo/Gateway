import { removeAccents } from '../../../common/utils/text';
import { centsToDecimalString } from '../../../common/utils/money';

// Manual de Padrões para Iniciação do Pix (BR Code / EMV® QRCPS-MPM) — Banco Central do Brasil.

const GUI = 'br.gov.bcb.pix';

function tlv(id: string, value: string): string {
  if (value.length > 99) throw new RangeError(`campo EMV ${id} excede 99 caracteres`);
  return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF), exigido no campo 63 do BR Code. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Restringe a ASCII imprimível (BR Code não aceita acentos). */
function emvText(value: string, max: number): string {
  return removeAccents(value)
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, max);
}

function finalize(fields: string): string {
  const withCrcId = `${fields}6304`;
  return withCrcId + crc16(withCrcId);
}

export interface DynamicBrCodeInput {
  /** URL do payload (location) retornada pelo PSP, sem "https://". */
  location: string;
  merchantName: string;
  merchantCity: string;
}

/** BR Code dinâmico (cobrança imediata/"cob"): valor e dados vêm do payload JSON no location. */
export function buildDynamicPixBrCode(input: DynamicBrCodeInput): string {
  const location = input.location.replace(/^https?:\/\//i, '');
  const merchantAccount = tlv('00', GUI) + tlv('25', location);
  return finalize(
    tlv('00', '01') +
      tlv('01', '12') + // uso único
      tlv('26', merchantAccount) +
      tlv('52', '0000') +
      tlv('53', '986') +
      tlv('58', 'BR') +
      tlv('59', emvText(input.merchantName, 25)) +
      tlv('60', emvText(input.merchantCity, 15)) +
      tlv('62', tlv('05', '***')),
  );
}

export interface StaticBrCodeInput {
  key: string;
  merchantName: string;
  merchantCity: string;
  amountCents?: number;
  txid?: string;
  description?: string;
}

/** BR Code estático (chave Pix + valor opcional). Útil para contingência. */
export function buildStaticPixBrCode(input: StaticBrCodeInput): string {
  let account = tlv('00', GUI) + tlv('01', input.key);
  if (input.description) account += tlv('02', emvText(input.description, 72));
  return finalize(
    tlv('00', '01') +
      tlv('26', account) +
      tlv('52', '0000') +
      tlv('53', '986') +
      (input.amountCents ? tlv('54', centsToDecimalString(input.amountCents)) : '') +
      tlv('58', 'BR') +
      tlv('59', emvText(input.merchantName, 25)) +
      tlv('60', emvText(input.merchantCity, 15)) +
      tlv('62', tlv('05', input.txid ? emvText(input.txid, 25) : '***')),
  );
}

/** Valida estrutura TLV e CRC de um "copia e cola" (defesa contra resposta corrompida do PSP). */
export function isValidBrCode(code: string): boolean {
  if (!/^[\x20-\x7E]+$/.test(code) || code.length < 30) return false;
  let pos = 0;
  while (pos < code.length) {
    const id = code.slice(pos, pos + 2);
    const len = Number(code.slice(pos + 2, pos + 4));
    if (!/^\d{2}$/.test(id) || Number.isNaN(len)) return false;
    if (id === '63') {
      return len === 4 && pos + 8 === code.length && crc16(code.slice(0, pos + 4)) === code.slice(pos + 4, pos + 8).toUpperCase();
    }
    pos += 4 + len;
  }
  return false;
}
