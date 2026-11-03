import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { MerchantStatus } from '@prisma/client';
import type { Request } from 'express';
import { UnauthorizedError } from '../../common/errors';
import { HashingService } from '../../infra/crypto/hashing.service';
import { PrismaService } from '../../infra/database/prisma.service';
import { API_KEY_PREFIX_LENGTH, extractApiKey } from './api-key.util';

/**
 * Autentica o lojista pela API key (Authorization: Bearer <key> ou X-Api-Key).
 * Lookup pelo prefixo público + comparação em tempo constante do HMAC (pepper fora do banco).
 * Mensagem de erro única para não revelar se o prefixo existe.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const apiKey = extractApiKey(req);
    if (!apiKey) throw new UnauthorizedError();

    const merchant = await this.prisma.merchant.findUnique({
      where: { apiKeyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH) },
      select: { id: true, name: true, document: true, documentType: true, status: true, apiKeyHash: true },
    });
    // HMAC calculado sempre (mesmo sem lojista) para não vazar a existência do prefixo por timing.
    const computed = this.hashing.hashApiKey(apiKey);
    const valid = HashingService.safeEqual(computed, merchant?.apiKeyHash ?? '0'.repeat(64)) && merchant !== null;
    if (!valid || !merchant || merchant.status !== MerchantStatus.ACTIVE) {
      this.logger.warn({ msg: 'api key rejected', reason: !valid ? 'invalid' : 'merchant_inactive' });
      throw new UnauthorizedError();
    }
    req.merchant = { id: merchant.id, name: merchant.name, document: merchant.document, documentType: merchant.documentType };
    return true;
  }
}
