import { randomBytes } from 'node:crypto';
import { CryptoIntegrityError } from '../../common/errors';
import { EncryptionService } from './encryption.service';
import { KeyRing } from './key-ring';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('EncryptionService (AES-256-GCM)', () => {
  const service = new EncryptionService(new KeyRing(`k1:${k1}`, 'k1'));

  it('cifra e decifra JSON preservando o conteúdo', () => {
    const secret = { clientId: 'abc', clientSecret: 's3cr3t', pixKey: 'chave@pix.com' };
    const token = service.encryptJson(secret, 'convenio:1:credentials');
    expect(token).toMatch(/^gcm1\.k1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(token).not.toContain('s3cr3t');
    expect(service.decryptJson(token, 'convenio:1:credentials')).toEqual(secret);
  });

  it('gera IV aleatório (mesmo plaintext => ciphertexts diferentes)', () => {
    expect(service.encrypt('x', 'a')).not.toEqual(service.encrypt('x', 'a'));
  });

  it('rejeita AAD diferente (ciphertext copiado para outro registro)', () => {
    const token = service.encrypt('secret', 'convenio:1:credentials');
    expect(() => service.decrypt(token, 'convenio:2:credentials')).toThrow(CryptoIntegrityError);
  });

  it('detecta adulteração do ciphertext', () => {
    const token = service.encrypt('secret-value', 'ctx');
    const parts = token.split('.');
    const ct = Buffer.from(parts[4], 'base64url');
    ct[0] ^= 0x01;
    parts[4] = ct.toString('base64url');
    expect(() => service.decrypt(parts.join('.'), 'ctx')).toThrow(CryptoIntegrityError);
  });

  it('rejeita tokens malformados ou de chave desconhecida', () => {
    expect(() => service.decrypt('garbage', 'ctx')).toThrow(CryptoIntegrityError);
    const token = service.encrypt('v', 'ctx').replace('.k1.', '.kX.');
    expect(() => service.decrypt(token, 'ctx')).toThrow(CryptoIntegrityError);
  });

  it('suporta rotação: chave antiga continua decifrando, nova chave cifra', () => {
    const old = service.encrypt('legacy', 'ctx');
    const rotated = new EncryptionService(new KeyRing(`k1:${k1},k2:${k2}`, 'k2'));
    expect(rotated.decrypt(old, 'ctx').toString()).toBe('legacy');
    expect(rotated.needsRotation(old)).toBe(true);
    const fresh = rotated.encrypt('new', 'ctx');
    expect(rotated.keyIdOf(fresh)).toBe('k2');
    expect(rotated.needsRotation(fresh)).toBe(false);
  });

  it('valida o chaveiro na inicialização', () => {
    expect(() => new KeyRing('k1:short', 'k1')).toThrow(/32 bytes/);
    expect(() => new KeyRing(`k1:${k1}`, 'k9')).toThrow(/não existe/);
    expect(() => new KeyRing(`k1:${k1},k1:${k2}`, 'k1')).toThrow(/duplicado/);
  });
});
