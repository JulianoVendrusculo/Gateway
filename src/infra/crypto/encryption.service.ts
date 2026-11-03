import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CryptoIntegrityError } from '../../common/errors';
import { KeyRing } from './key-ring';

const VERSION = 'gcm1';
const IV_BYTES = 12; // recomendado pelo NIST SP 800-38D para GCM
const TAG_BYTES = 16;

/**
 * AES-256-GCM (cifragem autenticada).
 * Formato do token: gcm1.<keyId>.<iv>.<tag>.<ciphertext> (base64url).
 * AAD (additional authenticated data) amarra o ciphertext ao seu contexto
 * (ex.: "convenio:<id>:credentials"): copiar o blob para outro registro faz a decifragem falhar.
 */
@Injectable()
export class EncryptionService {
  constructor(private readonly keyRing: KeyRing) {}

  encrypt(plaintext: string | Buffer, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keyRing.activeKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.keyRing.activeKeyId, b64(iv), b64(tag), b64(ciphertext)].join('.');
  }

  decrypt(token: string, aad: string): Buffer {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new CryptoIntegrityError('formato de ciphertext inválido');
    }
    const [, keyId, ivB64, tagB64, ctB64] = parts;
    const key = this.keyRing.get(keyId);
    if (!key) throw new CryptoIntegrityError(`chave de criptografia desconhecida: ${keyId}`);
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CryptoIntegrityError('IV/tag com tamanho inválido');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
    } catch (cause) {
      // Tag inválida = dado adulterado, AAD incorreto ou chave errada. Nunca retorna plaintext parcial.
      throw new CryptoIntegrityError('falha de autenticação do ciphertext (adulterado ou AAD/chave incorretos)', {
        cause,
      });
    }
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(token: string, aad: string): T {
    return JSON.parse(this.decrypt(token, aad).toString('utf8')) as T;
  }

  keyIdOf(token: string): string | undefined {
    return token.split('.')[1];
  }

  /** true se o dado foi cifrado com uma chave que não é a ativa (candidato a re-cifragem). */
  needsRotation(token: string): boolean {
    return this.keyIdOf(token) !== this.keyRing.activeKeyId;
  }

  get activeKeyId(): string {
    return this.keyRing.activeKeyId;
  }
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}
