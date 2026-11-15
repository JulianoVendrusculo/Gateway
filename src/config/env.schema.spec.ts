import { parseEnv } from './env.schema';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

const base = {
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/payment_gateway?schema=public',
  ENCRYPTION_KEYS: `k1:${key(1)}`,
  ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  BLIND_INDEX_KEY: key(2),
  API_KEY_PEPPER: key(3),
  ADMIN_API_TOKEN: 'a'.repeat(32),
};

const secret = (c: string) => c.repeat(32);

describe('env schema', () => {
  it('aplica defaults seguros quando as variáveis opcionais não são informadas', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      TRUST_PROXY: false,
      WEBHOOK_REQUIRE_MTLS: false,
      // O payload do webhook só é confiado se alguém desligar isto explicitamente.
      WEBHOOK_CONFIRM_WITH_PROVIDER: true,
      RECONCILIATION_ENABLED: true,
      CORS_ORIGINS: [],
      BANK_URL_ALLOWED_HOSTS: [],
      BANK_HTTP_TIMEOUT_MS: 20000,
    });
    expect(env.WEBHOOK_SECRET_BB).toBeUndefined();
  });

  it('converte booleanos, números e listas a partir de texto', () => {
    const env = parseEnv({
      ...base,
      PORT: '8080',
      TRUST_PROXY: 'true',
      WEBHOOK_REQUIRE_MTLS: '1',
      WEBHOOK_CONFIRM_WITH_PROVIDER: 'false',
      RECONCILIATION_ENABLED: '0',
      BANK_URL_ALLOWED_HOSTS: ' .bb.com.br , .caixa.gov.br ,',
      WEBHOOK_SECRET_BB: '',
    });
    expect(env).toMatchObject({
      PORT: 8080,
      TRUST_PROXY: true,
      WEBHOOK_REQUIRE_MTLS: true,
      WEBHOOK_CONFIRM_WITH_PROVIDER: false,
      RECONCILIATION_ENABLED: false,
      BANK_URL_ALLOWED_HOSTS: ['.bb.com.br', '.caixa.gov.br'],
    });
    expect(env.WEBHOOK_SECRET_BB).toBeUndefined();
  });

  it('recusa valores inválidos sem ecoar o conteúdo das variáveis', () => {
    const attempt = () => parseEnv({ ...base, BLIND_INDEX_KEY: 'chave-curta-demais', TRUST_PROXY: 'sim', WEBHOOK_SECRET_BB: 'curto' });
    expect(attempt).toThrow(/BLIND_INDEX_KEY/);
    expect(attempt).toThrow(/TRUST_PROXY/);
    expect(attempt).toThrow(/WEBHOOK_SECRET_BB/);
    expect(attempt).not.toThrow(/chave-curta-demais/);
  });

  it('em produção exige autenticação de webhook e proíbe hosts locais na allowlist', () => {
    const production = { ...base, NODE_ENV: 'production' };
    expect(() => parseEnv(production)).toThrow(/WEBHOOK_REQUIRE_MTLS/);
    expect(() => parseEnv({ ...production, WEBHOOK_SECRET_BB: secret('b') })).toThrow(/WEBHOOK_REQUIRE_MTLS/);
    expect(() => parseEnv({ ...production, WEBHOOK_REQUIRE_MTLS: 'true', BANK_URL_ALLOWED_HOSTS: '.bb.com.br,localhost' })).toThrow(/BANK_URL_ALLOWED_HOSTS/);

    expect(parseEnv({ ...production, WEBHOOK_REQUIRE_MTLS: 'true' }).WEBHOOK_REQUIRE_MTLS).toBe(true);
    expect(parseEnv({ ...production, WEBHOOK_SECRET_BB: secret('b'), WEBHOOK_SECRET_CAIXA: secret('c') }).WEBHOOK_SECRET_CAIXA).toBe(secret('c'));
  });
});
