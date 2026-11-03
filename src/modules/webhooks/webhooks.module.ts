import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ProcessWebhookUseCase } from './process-webhook.use-case';
import { WebhookAuthGuard } from './webhook-auth.guard';
import { BancoDoBrasilWebhooksController, CaixaWebhooksController } from './webhooks.controller';

@Module({
  imports: [PaymentsModule],
  controllers: [BancoDoBrasilWebhooksController, CaixaWebhooksController],
  providers: [ProcessWebhookUseCase, WebhookAuthGuard],
})
export class WebhooksModule {}
