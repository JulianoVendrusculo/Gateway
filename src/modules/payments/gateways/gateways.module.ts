import { Module } from '@nestjs/common';
import { IPaymentGateway } from '../domain/payment-gateway.port';
import { BancoDoBrasilAdapter } from './banco-do-brasil/bb.adapter';
import { CaixaAdapter } from './caixa/caixa.adapter';
import { MockAcquirerAdapter } from './card/mock-acquirer.adapter';
import { PAYMENT_GATEWAYS, PaymentGatewayRegistry } from './payment-gateway.registry';
import { OAuth2TokenProvider } from './shared/oauth2-token.provider';

@Module({
  providers: [
    OAuth2TokenProvider,
    BancoDoBrasilAdapter,
    CaixaAdapter,
    MockAcquirerAdapter,
    {
      provide: PAYMENT_GATEWAYS,
      inject: [BancoDoBrasilAdapter, CaixaAdapter, MockAcquirerAdapter],
      useFactory: (...gateways: IPaymentGateway[]) => gateways,
    },
    PaymentGatewayRegistry,
  ],
  exports: [PaymentGatewayRegistry],
})
export class GatewaysModule {}
