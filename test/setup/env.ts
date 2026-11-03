// Ambiente isolado para e2e: banco dedicado, chaves fixas de teste, logs silenciados.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'silent';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://gateway:gateway@localhost:5432/payment_gateway_test?schema=public';
process.env.ENCRYPTION_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
process.env.ENCRYPTION_ACTIVE_KEY_ID = 'k1';
process.env.BLIND_INDEX_KEY = Buffer.alloc(32, 2).toString('base64');
process.env.API_KEY_PEPPER = Buffer.alloc(32, 3).toString('base64');
process.env.ADMIN_API_TOKEN = 'e2e-admin-token-0123456789abcdef0123456789';
process.env.WEBHOOK_SECRET_BB = 'e2e-bb-webhook-secret-0123456789abcdef';
process.env.WEBHOOK_SECRET_CAIXA = 'e2e-caixa-webhook-secret-0123456789abcd';
process.env.BANK_URL_ALLOWED_HOSTS = 'localhost';
process.env.RECONCILIATION_ENABLED = 'false';
process.env.THROTTLE_LIMIT = '10000';
process.env.BANK_HTTP_TIMEOUT_MS = '5000';
