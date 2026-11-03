import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, TransactionEventSource } from '@prisma/client';
import { ResourceNotFoundError, ValidationError } from '../../../common/errors';
import { PrismaService } from '../../../infra/database/prisma.service';
import { CustomersService } from '../../customers/customers.service';
import { renderBoletoPdf } from '../boleto/boleto-pdf.renderer';
import { ProviderData } from '../domain/payment-gateway.port';
import { PaymentPresenter, PaymentView } from './payment.presenter';
import { SyncPaymentStatusUseCase } from './sync-payment-status.use-case';
import { TransactionRepository } from './transaction.repository';

const BANKS: Record<string, { code: string; name: string }> = {
  BANCO_DO_BRASIL: { code: '001', name: 'Banco do Brasil' },
  CAIXA: { code: '104', name: 'CAIXA' },
};

@Injectable()
export class GetPaymentUseCase {
  private readonly logger = new Logger(GetPaymentUseCase.name);

  constructor(
    private readonly transactions: TransactionRepository,
    private readonly presenter: PaymentPresenter,
    private readonly sync: SyncPaymentStatusUseCase,
    private readonly customers: CustomersService,
    private readonly prisma: PrismaService,
  ) {}

  async execute(merchantId: string, id: string, refresh = false): Promise<PaymentView> {
    let tx = await this.transactions.findForMerchant(id, merchantId);
    if (!tx) throw new ResourceNotFoundError('Pagamento');
    if (refresh) {
      try {
        await this.sync.execute(tx.id, TransactionEventSource.API);
        tx = (await this.transactions.findForMerchant(id, merchantId))!;
      } catch (err) {
        // Consulta ao banco é "best effort": devolve o último estado conhecido.
        this.logger.warn({ msg: 'on-demand sync failed', transactionId: id, err });
      }
    }
    return this.presenter.present(tx, tx.customer);
  }

  async boletoPdf(merchantId: string, id: string): Promise<{ filename: string; pdf: Buffer }> {
    const tx = await this.prisma.transaction.findFirst({ where: { id, merchantId }, include: { customer: true, merchant: true, convenio: true } });
    if (!tx) throw new ResourceNotFoundError('Pagamento');
    const boleto = (tx.providerData as ProviderData | null)?.boleto;
    if (tx.method !== PaymentMethod.BOLETO || !boleto) throw new ValidationError('Pagamento não possui boleto registrado');

    const payer = this.customers.toPayer(tx.customer);
    const settings = tx.convenio.settings as Record<string, unknown>;
    const agency = settings.agencia ?? settings.unidade ?? '';
    const code = settings.numeroConvenio ?? settings.codigoBeneficiario ?? '';
    const bank = BANKS[tx.provider] ?? { code: boleto.barcode.slice(0, 3), name: tx.provider };
    const address = payer.address
      ? `${payer.address.street}, ${payer.address.number}${payer.address.complement ? ` - ${payer.address.complement}` : ''} - ${payer.address.neighborhood} - ${payer.address.city}/${payer.address.state} - CEP ${payer.address.zipCode}`
      : undefined;

    const pdf = await renderBoletoPdf({
      bankCode: bank.code,
      bankName: bank.name,
      digitableLine: boleto.digitableLine,
      barcode: boleto.barcode,
      dueDate: boleto.dueDate,
      issueDate: boleto.issueDate,
      amountCents: tx.amountCents,
      nossoNumero: boleto.nossoNumero,
      documentNumber: tx.externalReference ?? tx.id.slice(0, 8).toUpperCase(),
      beneficiary: { name: tx.merchant.name, document: tx.merchant.document, agencyCode: `${String(agency)} / ${String(code)}` },
      payer: { name: payer.name, document: payer.document, address },
      instructions: boleto.instructions ?? [],
      pixCopyPaste: boleto.pixCopyPaste,
    });
    return { filename: `boleto-${boleto.nossoNumero}.pdf`, pdf };
  }
}
