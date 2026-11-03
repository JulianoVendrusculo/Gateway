import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const base64Key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'deve ser base64 de exatamente 32 bytes (gere com `npm run keys:generate`)',
});

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined))
  .refine((v) => v === undefined || v.length >= 32, { message: 'mínimo de 32 caracteres' });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: booleanFromString.default('false'),
    CORS_ORIGINS: csv,

    DATABASE_URL: z.string().url(),

    ENCRYPTION_KEYS: z.string().min(1),
    ENCRYPTION_ACTIVE_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    BLIND_INDEX_KEY: base64Key32,
    API_KEY_PEPPER: base64Key32,
    ADMIN_API_TOKEN: z.string().min(32),

    WEBHOOK_SECRET_BB: optionalSecret,
    WEBHOOK_SECRET_CAIXA: optionalSecret,
    WEBHOOK_REQUIRE_MTLS: booleanFromString.default('false'),
    WEBHOOK_MTLS_VERIFY_HEADER: z.string().default('x-ssl-client-verify'),
    WEBHOOK_MTLS_SUBJECT_HEADER: z.string().default('x-ssl-client-s-dn'),
    WEBHOOK_BB_ALLOWED_SUBJECTS: csv,
    WEBHOOK_CAIXA_ALLOWED_SUBJECTS: csv,
    WEBHOOK_BB_ALLOWED_IPS: csv,
    WEBHOOK_CAIXA_ALLOWED_IPS: csv,
    WEBHOOK_CONFIRM_WITH_PROVIDER: booleanFromString.default('true'),

    BANK_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
    BANK_HTTP_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
    BANK_URL_ALLOWED_HOSTS: csv,

    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24),
    IDEMPOTENCY_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    RECONCILIATION_ENABLED: booleanFromString.default('true'),
    RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10000).default(300000),
    RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
    RECONCILIATION_MIN_RESYNC_SECONDS: z.coerce.number().int().min(10).default(600),
    THROTTLE_TTL_MS: z.coerce.number().int().min(1000).default(60000),
    THROTTLE_LIMIT: z.coerce.number().int().min(1).default(120),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Em produção, todo webhook precisa de ao menos um mecanismo de autenticação forte.
    if (!env.WEBHOOK_REQUIRE_MTLS && (!env.WEBHOOK_SECRET_BB || !env.WEBHOOK_SECRET_CAIXA)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEBHOOK_REQUIRE_MTLS'],
        message: 'em produção, habilite WEBHOOK_REQUIRE_MTLS ou defina WEBHOOK_SECRET_BB e WEBHOOK_SECRET_CAIXA',
      });
    }
    if (env.BANK_URL_ALLOWED_HOSTS.some((h) => /localhost|127\.0\.0\.1/.test(h))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BANK_URL_ALLOWED_HOSTS'],
        message: 'hosts locais não são permitidos em produção',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Nunca imprime valores — apenas nomes das variáveis e o motivo.
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}`);
  }
  return result.data;
}
