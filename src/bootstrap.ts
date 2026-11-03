import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppConfig } from './config/app-config';

/** Configuração HTTP compartilhada entre runtime e testes e2e. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.get('TRUST_PROXY'));
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.useBodyParser('json', { limit: '256kb', strict: true });
  const origins = config.get('CORS_ORIGINS');
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'idempotent-replayed'],
      maxAge: 600,
    });
  }
  app.enableShutdownHooks();
}
