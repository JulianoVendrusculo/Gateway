import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service';

/**
 * Leituras de transação. Na v2 toda ESCRITA de status acontece com a Charge bloqueada
 * (ver ChargeRepository, PaymentSettlementService e AttemptLifecycleService).
 */
@Injectable()
export class TransactionRepository {
  constructor(private readonly prisma: PrismaService) {}

  findForMerchant(id: string, merchantId: string) {
    // Sempre filtrado pelo lojista autenticado (previne IDOR).
    return this.prisma.transaction.findFirst({ where: { id, merchantId }, include: { customer: true } });
  }
}
