import { X509Certificate } from 'node:crypto';
import { SecureContextOptions, TLSSocket, createSecureContext, rootCertificates } from 'node:tls';

/** Material de certificado cliente (A1 ICP-Brasil normalmente em .pfx) — sempre decifrado só em memória. */
export interface MtlsMaterial {
  format: 'PEM' | 'PFX';
  certPem?: string;
  keyPem?: string;
  pfx?: Buffer;
  passphrase?: string;
  /** CA(s) adicionais para validar o servidor do banco (somadas às raízes públicas, não substituem). */
  caPem?: string;
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  fingerprint256: string;
}

export class InvalidCertificateError extends Error {}

export function toSecureContextOptions(m: MtlsMaterial): SecureContextOptions {
  const base: SecureContextOptions = { minVersion: 'TLSv1.2' };
  if (m.caPem) base.ca = [...rootCertificates, m.caPem];
  if (m.format === 'PFX') return { ...base, pfx: m.pfx, passphrase: m.passphrase };
  return { ...base, cert: m.certPem, key: m.keyPem, passphrase: m.passphrase };
}

/**
 * Valida o par certificado/chave (senha correta, chave corresponde ao certificado,
 * dentro da validade) e extrai metadados para monitoramento de expiração.
 */
export function inspectClientCertificate(m: MtlsMaterial, now: Date = new Date()): CertificateInfo {
  if (m.format === 'PFX' && !m.pfx?.length) throw new InvalidCertificateError('PFX ausente');
  if (m.format === 'PEM' && (!m.certPem || !m.keyPem)) throw new InvalidCertificateError('certPem e keyPem são obrigatórios');

  let socket: TLSSocket | undefined;
  try {
    const secureContext = createSecureContext(toSecureContextOptions(m));
    socket = new TLSSocket(null as never, { secureContext });
    const local = socket.getCertificate();
    if (!local || !('raw' in local) || !local.raw) throw new InvalidCertificateError('certificado cliente não encontrado');
    const x509 = new X509Certificate(local.raw);
    const info: CertificateInfo = {
      subject: x509.subject.replace(/\n/g, ', '),
      issuer: x509.issuer.replace(/\n/g, ', '),
      validFrom: new Date(x509.validFrom),
      validTo: new Date(x509.validTo),
      fingerprint256: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
    };
    if (info.validTo <= now) throw new InvalidCertificateError(`certificado expirado em ${info.validTo.toISOString()}`);
    if (info.validFrom > now) throw new InvalidCertificateError('certificado ainda não é válido');
    return info;
  } catch (err) {
    if (err instanceof InvalidCertificateError) throw err;
    // Mensagens do OpenSSL ("mac verify failure", "key values mismatch") são seguras e úteis.
    throw new InvalidCertificateError(`certificado/chave inválidos: ${(err as Error).message}`);
  } finally {
    socket?.destroy();
  }
}
