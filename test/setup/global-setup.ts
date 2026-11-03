import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CERT_DIR = join(__dirname, '..', '.certs');

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'ignore' });
}

/** PKI de teste: CA do "banco", certificado do servidor e certificados cliente (válido e não confiável). */
function generateCertificates(): void {
  mkdirSync(CERT_DIR, { recursive: true });
  const p = (f: string) => join(CERT_DIR, f);
  if (existsSync(p('client.pfx'))) return;

  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('ca.key'), '-out', p('ca.crt'), '-days', '30', '-subj', '/CN=Fake Bank Test CA']);

  writeFileSync(p('server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('server.key'), '-out', p('server.csr'), '-subj', '/CN=localhost']);
  openssl(['x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('server.crt'), '-days', '30', '-extfile', p('server.ext')]);

  writeFileSync(p('client.ext'), 'extendedKeyUsage=clientAuth\n');
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('client.key'), '-out', p('client.csr'), '-subj', '/CN=Loja Teste:11222333000181/O=E2E']);
  openssl(['x509', '-req', '-in', p('client.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('client.crt'), '-days', '30', '-extfile', p('client.ext')]);
  openssl(['pkcs12', '-export', '-inkey', p('client.key'), '-in', p('client.crt'), '-out', p('client.pfx'), '-passout', 'pass:e2e-pfx-pass']);

  // Certificado cliente autoassinado: o banco falso NÃO confia nele (teste negativo de mTLS).
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('rogue.key'), '-out', p('rogue.crt'), '-days', '30', '-subj', '/CN=Rogue Client']);
}

export default function globalSetup(): void {
  generateCertificates();
  const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://gateway:gateway@localhost:5432/payment_gateway_test?schema=public';
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: databaseUrl } });
}
