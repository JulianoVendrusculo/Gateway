import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { UnsupportedPaymentMethodError } from '../../../common/errors';
import { AuthenticatedMerchant } from '../../auth/authenticated-merchant';
import { CardTokenResult, RawCardData, isCardTokenizer } from '../domain/payment-gateway.port';
import { PaymentGatewayRegistry } from '../gateways/payment-gateway.registry';
import { ConvenioResolver } from './convenio-resolver';
import { GatewayContextFactory } from './gateway-context.factory';

/**
 * Tokenização server-side (o PAN trafega apenas em memória até a adquirente).
 * Para reduzir o escopo PCI do lojista (SAQ A), prefira tokenização client-side
 * com o SDK JS da adquirente, enviando ao gateway somente o token.
 */
@Injectable()
export class TokenizeCardUseCase {
  private readonly logger = new Logger(TokenizeCardUseCase.name);

  constructor(
    private readonly resolver: ConvenioResolver,
    private readonly registry: PaymentGatewayRegistry,
    private readonly contextFactory: GatewayContextFactory,
  ) {}

  async execute(merchant: AuthenticatedMerchant, card: RawCardData, convenioId?: string): Promise<CardTokenResult & { convenioId: string }> {
    const convenio = await this.resolver.resolve(merchant.id, PaymentMethod.CREDIT_CARD, convenioId);
    const gateway = this.registry.forMethod(convenio.provider, PaymentMethod.CREDIT_CARD);
    if (!isCardTokenizer(gateway)) throw new UnsupportedPaymentMethodError(convenio.provider, 'CARD_TOKENIZATION');
    const ctx = this.contextFactory.build(convenio, { name: merchant.name, document: merchant.document });
    const result = await gateway.tokenizeCard(ctx, card);
    this.logger.log({ msg: 'card tokenized', merchantId: merchant.id, convenioId: convenio.id, brand: result.brand, last4: result.last4 });
    return { ...result, convenioId: convenio.id };
  }
}
