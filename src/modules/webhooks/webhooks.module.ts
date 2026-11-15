import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ProcessWebhookUseCase } from './process-webhook.use-case';
import { WebhookAuthGuard } from './webhook-auth.guard';
import { BancoDoBrasilWebhooksController, CaixaWebhooksController, MockAcquirerWebhooksController } from './webhooks.controller';

@Module({
  imports: [PaymentsModule],
  controllers: [BancoDoBrasilWebhooksController, CaixaWebhooksController, MockAcquirerWebhooksController],
  providers: [ProcessWebhookUseCase, WebhookAuthGuard],
})
export class WebhooksModule {}
