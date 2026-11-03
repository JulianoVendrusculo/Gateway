import { Inject, Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentProvider } from '@prisma/client';
import { UnsupportedPaymentMethodError } from '../../../common/errors';
import { IPaymentGateway } from '../domain/payment-gateway.port';

export const PAYMENT_GATEWAYS = Symbol('PAYMENT_GATEWAYS');

/**
 * Registro de estratégias: resolve o adapter em runtime a partir do provedor do convênio.
 * Adicionar um banco novo = implementar IPaymentGateway e registrá-lo em PAYMENT_GATEWAYS.
 */
@Injectable()
export class PaymentGatewayRegistry {
  private readonly byProvider = new Map<PaymentProvider, IPaymentGateway>();

  constructor(@Inject(PAYMENT_GATEWAYS) gateways: IPaymentGateway[]) {
    for (const gateway of gateways) {
      if (this.byProvider.has(gateway.provider)) throw new Error(`Gateway duplicado para ${gateway.provider}`);
      this.byProvider.set(gateway.provider, gateway);
    }
  }

  get(provider: PaymentProvider): IPaymentGateway {
    const gateway = this.byProvider.get(provider);
    if (!gateway) throw new Error(`Nenhum adapter registrado para o provedor ${provider}`);
    return gateway;
  }

  forMethod(provider: PaymentProvider, method: PaymentMethod): IPaymentGateway {
    const gateway = this.get(provider);
    if (!gateway.supportedMethods.has(method)) throw new UnsupportedPaymentMethodError(provider, method);
    return gateway;
  }

  providers(): PaymentProvider[] {
    return [...this.byProvider.keys()];
  }
}
