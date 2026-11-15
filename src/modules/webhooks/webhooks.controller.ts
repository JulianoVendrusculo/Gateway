import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { SkipThrottle } from '@nestjs/throttler';
import { ProcessWebhookUseCase, WebhookSummary } from './process-webhook.use-case';
import { WebhookAuthGuard, WebhookProvider } from './webhook-auth.guard';

// A API Pix do BACEN acrescenta "/pix" à URL registrada; por isso cada provedor aceita ambas as rotas.
// A variante /t/:token permite embutir o segredo no path (útil quando o PSP descarta query strings).
const ROUTES = ['', 'pix', 't/:token', 't/:token/pix'];

@Controller('v1/webhooks/bb')
@SkipThrottle()
@WebhookProvider(PaymentProvider.BANCO_DO_BRASIL)
@UseGuards(WebhookAuthGuard)
export class BancoDoBrasilWebhooksController {
  constructor(private readonly process: ProcessWebhookUseCase) {}

  @Post(ROUTES)
  @HttpCode(200)
  receive(@Body() payload: unknown): Promise<WebhookSummary> {
    return this.process.execute(PaymentProvider.BANCO_DO_BRASIL, payload);
  }
}

@Controller('v1/webhooks/caixa')
@SkipThrottle()
@WebhookProvider(PaymentProvider.CAIXA)
@UseGuards(WebhookAuthGuard)
export class CaixaWebhooksController {
  constructor(private readonly process: ProcessWebhookUseCase) {}

  @Post(ROUTES)
  @HttpCode(200)
  receive(@Body() payload: unknown): Promise<WebhookSummary> {
    return this.process.execute(PaymentProvider.CAIXA, payload);
  }
}

/**
 * Webhook do provedor SIMULADO de link de cartão. Existe para exercitar o fluxo de confirmação
 * tardia em desenvolvimento e nos testes; o guard recusa esta rota em produção.
 * O adapter real de link de cartão receberá as notificações nas rotas do próprio banco.
 */
@Controller('v1/webhooks/mock-acquirer')
@SkipThrottle()
@WebhookProvider(PaymentProvider.MOCK_ACQUIRER)
@UseGuards(WebhookAuthGuard)
export class MockAcquirerWebhooksController {
  constructor(private readonly process: ProcessWebhookUseCase) {}

  @Post(['', 't/:token'])
  @HttpCode(200)
  receive(@Body() payload: unknown): Promise<WebhookSummary> {
    return this.process.execute(PaymentProvider.MOCK_ACQUIRER, payload);
  }
}
