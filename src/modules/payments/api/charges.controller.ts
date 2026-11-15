import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ValidationError } from '../../../common/errors';
import { ApiKeyGuard } from '../../auth/api-key.guard';
import { AuthenticatedMerchant } from '../../auth/authenticated-merchant';
import { CurrentMerchant } from '../../auth/current-merchant.decorator';
import { GetPaymentUseCase } from '../application/get-payment.use-case';
import { ChargeView } from '../application/payment.presenter';

const EXTERNAL_REFERENCE = /^[A-Za-z0-9_.:-]{1,64}$/;

@Controller('v1/charges')
@UseGuards(ApiKeyGuard)
export class ChargesController {
  constructor(private readonly payments: GetPaymentUseCase) {}

  /**
   * Situação da cobrança única de uma inscrição e a tentativa ativa (QR Code, boleto ou link já emitidos).
   * O front usa esta rota para mostrar "aguardando confirmação" em vez de pedir outro pagamento.
   */
  @Get(':externalReference')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  get(@CurrentMerchant() merchant: AuthenticatedMerchant, @Param('externalReference') externalReference: string): Promise<ChargeView> {
    if (!EXTERNAL_REFERENCE.test(externalReference)) throw new ValidationError('externalReference inválido');
    return this.payments.charge(merchant.id, externalReference);
  }
}
