import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import { AppConfig } from '../../config/app-config';

/**
 * Nunca logar: credenciais, tokens, certificados, dados de cartão (PCI-DSS req. 3/10) e PII desnecessária.
 * A redação é a última linha de defesa — o código já evita logar bodies.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-webhook-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.clientSecret',
  '*.client_secret',
  '*.access_token',
  '*.developerAppKey',
  '*.acquirerToken',
  '*.passphrase',
  '*.password',
  '*.keyPem',
  '*.pfxBase64',
  '*.number',
  '*.cvv',
  '*.securityCode',
  '*.document',
  '*.piiCiphertext',
  '*.credentialsCiphertext',
  '*.certificateCiphertext',
];

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function maskUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url
    .replace(/(\/t\/)[^/?#]+/g, '$1[REDACTED]')
    .replace(/([?&](?:token|gw-dev-app-key|gw-app-key)=)[^&#]*/gi, '$1[REDACTED]');
}

export function buildLoggerParams(config: AppConfig): Params {
  const isDev = config.get('NODE_ENV') === 'development';
  return {
    pinoHttp: {
      level: config.get('LOG_LEVEL'),
      base: { service: 'payment-gateway' },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label: string) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      serializers: {
        req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: maskUrl(req.url),
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
      ...(isDev ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } } } : {}),
    },
  };
}
