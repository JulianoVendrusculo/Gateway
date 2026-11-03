import { Injectable, Logger } from '@nestjs/common';
import { DocumentType, Merchant } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ConflictError, ResourceNotFoundError } from '../../common/errors';
import { detectDocumentType } from '../../common/validation/brazilian-document';
import { HashingService } from '../../infra/crypto/hashing.service';
import { PrismaService, isUniqueViolation } from '../../infra/database/prisma.service';
import { API_KEY_PREFIX_LENGTH, generateApiKey } from '../auth/api-key.util';
import { CreateMerchantDto } from './dto/create-merchant.dto';

export type MerchantView = Omit<Merchant, 'apiKeyHash'>;

@Injectable()
export class MerchantsService {
  private readonly logger = new Logger(MerchantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
  ) {}

  /** A API key é exibida UMA única vez; apenas o HMAC é persistido. */
  async create(dto: CreateMerchantDto): Promise<{ merchant: MerchantView; apiKey: string }> {
    const apiKey = generateApiKey();
    try {
      const merchant = await this.prisma.merchant.create({
        data: {
          id: randomUUID(),
          name: dto.name,
          tradeName: dto.tradeName,
          document: dto.document,
          documentType: detectDocumentType(dto.document) === 'CPF' ? DocumentType.CPF : DocumentType.CNPJ,
          email: dto.email.toLowerCase(),
          apiKeyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH),
          apiKeyHash: this.hashing.hashApiKey(apiKey),
        },
      });
      this.logger.log({ msg: 'merchant created', merchantId: merchant.id });
      return { merchant: strip(merchant), apiKey };
    } catch (err) {
      if (isUniqueViolation(err, 'document')) throw new ConflictError('Já existe um lojista com este documento');
      throw err;
    }
  }

  async rotateApiKey(id: string): Promise<{ merchant: MerchantView; apiKey: string }> {
    await this.get(id);
    const apiKey = generateApiKey();
    const merchant = await this.prisma.merchant.update({
      where: { id },
      data: { apiKeyPrefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH), apiKeyHash: this.hashing.hashApiKey(apiKey) },
    });
    this.logger.log({ msg: 'merchant api key rotated', merchantId: id });
    return { merchant: strip(merchant), apiKey };
  }

  async get(id: string): Promise<MerchantView> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id } });
    if (!merchant) throw new ResourceNotFoundError('Lojista');
    return strip(merchant);
  }
}

function strip(m: Merchant): MerchantView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKeyHash, ...rest } = m;
  return rest;
}
