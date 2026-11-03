import { Injectable } from '@nestjs/common';
import { Convenio, PaymentMethod } from '@prisma/client';
import { ConvenioNotFoundError } from '../../../common/errors';
import { PrismaService } from '../../../infra/database/prisma.service';

/**
 * Seleciona o convênio que vai processar a cobrança:
 *  - convenioId explícito (deve pertencer ao lojista, estar ativo e suportar o método); ou
 *  - o convênio ativo de maior prioridade que suporte o método.
 */
@Injectable()
export class ConvenioResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(merchantId: string, method: PaymentMethod, convenioId?: string): Promise<Convenio> {
    const convenio = await this.prisma.convenio.findFirst({
      where: { merchantId, isActive: true, supportedMethods: { has: method }, ...(convenioId ? { id: convenioId } : {}) },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (!convenio) throw new ConvenioNotFoundError(method, convenioId);
    return convenio;
  }
}
