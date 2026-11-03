import { Injectable } from '@nestjs/common';
import { Customer, DocumentType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { maskDocument } from '../../common/utils/text';
import { EncryptionService } from '../../infra/crypto/encryption.service';
import { HashingService } from '../../infra/crypto/hashing.service';
import { PrismaService } from '../../infra/database/prisma.service';
import { PayerAddress, PayerData } from '../payments/domain/payment-gateway.port';

export interface CustomerInput {
  name: string;
  document: string;
  documentType: 'CPF' | 'CNPJ';
  email?: string;
  phone?: string;
  address?: PayerAddress;
}

/** PII cifrada (LGPD art. 46): documento, e-mail, telefone e endereço. */
interface CustomerPii {
  document: string;
  email?: string;
  phone?: string;
  address?: PayerAddress;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly hashing: HashingService,
  ) {}

  /** Upsert pelo blind index do documento (único por lojista) — sem nunca gravar o CPF/CNPJ em claro. */
  async upsert(merchantId: string, input: CustomerInput): Promise<Customer> {
    const documentHash = this.hashing.blindIndex('customer-document', input.document);
    const pii: CustomerPii = { document: input.document, email: input.email, phone: input.phone, address: input.address };
    const piiCiphertext = this.encryption.encryptJson(pii, aad(merchantId, documentHash));
    return this.prisma.customer.upsert({
      where: { merchantId_documentHash: { merchantId, documentHash } },
      create: {
        id: randomUUID(),
        merchantId,
        name: input.name,
        documentType: input.documentType === 'CPF' ? DocumentType.CPF : DocumentType.CNPJ,
        documentHash,
        documentMasked: maskDocument(input.document),
        piiCiphertext,
      },
      update: { name: input.name, piiCiphertext },
    });
  }

  toPayer(customer: Customer): PayerData {
    const pii = this.encryption.decryptJson<CustomerPii>(customer.piiCiphertext, aad(customer.merchantId, customer.documentHash));
    return {
      name: customer.name,
      document: pii.document,
      documentType: customer.documentType,
      email: pii.email,
      phone: pii.phone,
      address: pii.address,
    };
  }
}

const aad = (merchantId: string, documentHash: string) => `customer:${merchantId}:${documentHash}`;
