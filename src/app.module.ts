import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildLoggerParams } from './common/logging/logger.config';
import { AppConfig } from './config/app-config';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './infra/crypto/crypto.module';
import { DatabaseModule } from './infra/database/database.module';
import { HttpModule } from './infra/http/http.module';
import { AuthModule } from './modules/auth/auth.module';
import { ConveniosModule } from './modules/convenios/convenios.module';
import { HealthController } from './modules/health/health.controller';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ inject: [AppConfig], useFactory: buildLoggerParams }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({ throttlers: [{ ttl: config.get('THROTTLE_TTL_MS'), limit: config.get('THROTTLE_LIMIT') }] }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    CryptoModule,
    HttpModule,
    AuthModule,
    MerchantsModule,
    ConveniosModule,
    PaymentsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // remove campos não declarados
        forbidNonWhitelisted: true, // ...e rejeita a requisição se existirem (mass assignment)
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        forbidUnknownValues: true,
        validationError: { target: false, value: false }, // nunca ecoa valores (podem ser PAN/CPF)
        stopAtFirstError: false,
      }),
    },
  ],
})
export class AppModule {}
