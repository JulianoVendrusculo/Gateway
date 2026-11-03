import { Injectable } from '@nestjs/common';
import { Convenio } from '@prisma/client';
import { EncryptionService } from '../../infra/crypto/encryption.service';
import { MtlsMaterial } from '../../infra/http/mtls-material';
import { ConvenioCredentials } from '../payments/domain/payment-gateway.port';

/** Forma persistida (cifrada) do certificado. PFX fica em base64 dentro do JSON cifrado. */
export interface StoredCertificate {
  format: 'PEM' | 'PFX';
  certPem?: string;
  keyPem?: string;
  pfxBase64?: string;
  passphrase?: string;
  caPem?: string;
}

const aad = (convenioId: string, part: 'credentials' | 'certificate') => `convenio:${convenioId}:${part}`;

/**
 * Único ponto do sistema que cifra/decifra segredos de convênio.
 * O AAD inclui o id do convênio: um blob copiado de outro registro não decifra.
 */
@Injectable()
export class ConvenioVault {
  constructor(private readonly encryption: EncryptionService) {}

  sealCredentials(convenioId: string, credentials: ConvenioCredentials): string {
    return this.encryption.encryptJson(credentials, aad(convenioId, 'credentials'));
  }

  openCredentials(convenio: Pick<Convenio, 'id' | 'credentialsCiphertext'>): ConvenioCredentials {
    return this.encryption.decryptJson<ConvenioCredentials>(convenio.credentialsCiphertext, aad(convenio.id, 'credentials'));
  }

  sealCertificate(convenioId: string, certificate: StoredCertificate): string {
    return this.encryption.encryptJson(certificate, aad(convenioId, 'certificate'));
  }

  openCertificate(convenio: Pick<Convenio, 'id' | 'certificateCiphertext'>): MtlsMaterial | undefined {
    if (!convenio.certificateCiphertext) return undefined;
    return toMtlsMaterial(this.encryption.decryptJson<StoredCertificate>(convenio.certificateCiphertext, aad(convenio.id, 'certificate')));
  }

  get activeKeyId(): string {
    return this.encryption.activeKeyId;
  }
}

export function toMtlsMaterial(c: StoredCertificate): MtlsMaterial {
  return {
    format: c.format,
    certPem: c.certPem,
    keyPem: c.keyPem,
    pfx: c.pfxBase64 ? Buffer.from(c.pfxBase64, 'base64') : undefined,
    passphrase: c.passphrase,
    caPem: c.caPem,
  };
}
