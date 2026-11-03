import { Body, Controller, Header, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard } from '../../auth/api-key.guard';
import { AuthenticatedMerchant } from '../../auth/authenticated-merchant';
import { CurrentMerchant } from '../../auth/current-merchant.decorator';
import { TokenizeCardUseCase } from '../application/tokenize-card.use-case';
import { TokenizeCardDto } from './dto/tokenize-card.dto';

@Controller('v1/cards')
@UseGuards(ApiKeyGuard)
export class CardsController {
  constructor(private readonly tokenize: TokenizeCardUseCase) {}

  /** Rate limit agressivo: endpoint alvo clássico de "card testing". */
  @Post('tokens')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async create(@CurrentMerchant() merchant: AuthenticatedMerchant, @Body() dto: TokenizeCardDto) {
    const result = await this.tokenize.execute(
      merchant,
      { number: dto.number, holderName: dto.holderName.toUpperCase(), expMonth: dto.expMonth, expYear: dto.expYear, cvv: dto.cvv },
      dto.convenioId,
    );
    return {
      token: result.token,
      brand: result.brand,
      last4: result.last4,
      expMonth: result.expMonth,
      expYear: result.expYear,
      fingerprint: result.fingerprint,
      convenioId: result.convenioId,
    };
  }
}
