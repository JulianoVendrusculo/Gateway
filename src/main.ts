import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig } from './config/app-config';

if (existsSync('.env') && process.env.NODE_ENV !== 'production') process.loadEnvFile('.env');

async function bootstrap(): Promise<void> {
  // bodyParser desligado aqui e registrado em configureApp com limite explícito.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  configureApp(app);
  await app.listen(app.get(AppConfig).get('PORT'));
}

bootstrap().catch((err: unknown) => {
  // Falhas de configuração (env inválido, chaves) devem derrubar o processo imediatamente.
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
