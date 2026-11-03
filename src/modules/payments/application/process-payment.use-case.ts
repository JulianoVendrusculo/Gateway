import { Injectable, Logger } from '@nestjs/common';
import { Convenio, PaymentMethod, Prisma, Transaction, TransactionEventSource, TransactionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError, BankIntegrationError, UnexpectedProcessingError, ValidationError } from '../../../common/errors';
import { diffInDays, parseIsoDate, todayBr } from '../../../common/utils/date-helpers';
import { isUniqueViolation } from '../../../infra/database/prisma.service';
import { AuthenticatedMerchant } from '../../auth/authenticated-merchant';
import { ConveniosService } from '../../convenios/convenios.service';
import { CustomerInput, CustomersService } from '../../customers/customers.service';
import { ChargeRequest, ChargeResult, IPaymentGateway, PayerData } from '../domain/payment-gateway.port';
import { PaymentGatewayRegistry } from '../gateways/payment-gateway.registry';
import { ConvenioResolver } from './convenio-resolver';
import { GatewayContextFactory } from './gateway-context.factory';
import { PaymentPresenter, PaymentView } from './payment.presenter';
import { TransactionRepository } from './transaction.repository';

export interface CreatePaymentCommand {
  merchant: AuthenticatedMerchant;
  idempotencyKey: string;
  method: PaymentMethod;
  amountCents: number;
  description?: string;
  externalReference?: string;
  convenioId?: string;
  customer: CustomerInput;
  pix?: { expiresInSeconds: number };
  boleto?: {
    dueDate: string;
    instructions: string[];
    finePercent?: number;
    interestMonthlyPercent?: number;
    acceptUntilDaysAfterDue?: number;
  };
  card?: { token: string; installments: number; capture: boolean; softDescriptor?: string };
  metadata?: Record<string, string | number | boolean>;
}

const MAX_BOLETO_DAYS_AHEAD = 5 * 365;
const DEFAULT_PIX_EXPIRATION = 3600;

/**
 * Orquestra a criação de uma cobrança:
 *   validar → resolver convênio → decifrar credenciais → registrar transação (write-ahead)
 *   → adapter do banco (Strategy) → aplicar resultado.
 *
 * A transação é gravada ANTES da chamada ao banco: se o processo cair no meio,
 * nada se perde — a reconciliação usa a referência determinística (txid/nosso número).
 */
@Injectable()
export class ProcessPaymentUseCase {
  private readonly logger = new Logger(ProcessPaymentUseCase.name);

  constructor(
    private readonly resolver: ConvenioResolver,
    private readonly registry: PaymentGatewayRegistry,
    private readonly contextFactory: GatewayContextFactory,
    private readonly convenios: ConveniosService,
    private readonly customers: CustomersService,
    private readonly transactions: TransactionRepository,
    private readonly presenter: PaymentPresenter,
  ) {}

  async execute(cmd: CreatePaymentCommand): Promise<PaymentView> {
    this.validateBusinessRules(cmd);

    const convenio = await this.resolver.resolve(cmd.merchant.id, cmd.method, cmd.convenioId);
    const gateway = this.registry.forMethod(convenio.provider, cmd.method);
    // Contexto é montado antes de qualquer efeito colateral: convênio quebrado falha cedo, sem transação órfã.
    const ctx = this.contextFactory.build(convenio, { name: cmd.merchant.name, document: cmd.merchant.document });

    const customer = await this.customers.upsert(cmd.merchant.id, cmd.customer);
    const transactionId = randomUUID();
    const request = await this.buildChargeRequest(cmd, transactionId, convenio, this.customers.toPayer(customer));

    let tx: Transaction;
    try {
      tx = await this.transactions.create(
        {
          id: transactionId,
          merchantId: cmd.merchant.id,
          convenioId: convenio.id,
          customerId: customer.id,
          method: cmd.method,
          provider: convenio.provider,
          status: TransactionStatus.PROCESSING,
          amountCents: cmd.amountCents,
          description: cmd.description,
          idempotencyKey: cmd.idempotencyKey,
          externalReference: cmd.externalReference,
          providerReference: gateway.providerReferenceFor(ctx, request) ?? null,
          metadata: cmd.metadata as Prisma.InputJsonObject | undefined,
        },
        { type: 'payment.created', source: TransactionEventSource.API, data: { convenioId: convenio.id } },
      );
    } catch (err) {
      // 2ª barreira de idempotência (UNIQUE merchant+idempotency_key): recuperação após lock expirado.
      if (isUniqueViolation(err, 'idempotency_key') || isUniqueViolation(err, 'idempotencyKey')) {
        const existing = await this.transactions.findByIdempotencyKey(cmd.merchant.id, cmd.idempotencyKey);
        if (existing) return this.presenter.present(existing, existing.customer);
      }
      throw err;
    }

    const log = { transactionId, merchantId: cmd.merchant.id, convenioId: convenio.id, provider: convenio.provider, method: cmd.method };
    this.logger.log({ msg: 'charge dispatching', ...log, amountCents: cmd.amountCents });

    let result: ChargeResult;
    try {
      result = await gateway.createCharge(ctx, request);
    } catch (err) {
      await this.handleChargeFailure(tx, err, log);
      if (err instanceof AppError) throw err.attachTransaction(tx.id);
      throw new UnexpectedProcessingError({ cause: err }).attachTransaction(tx.id);
    }

    const updated = await this.applyResult(tx, result, cmd, gateway);
    this.logger.log({ msg: 'charge created', ...log, status: updated.status, providerReference: updated.providerReference });
    return this.presenter.present(updated, customer);
  }

  // ---------------------------------------------------------------------------

  private validateBusinessRules(cmd: CreatePaymentCommand): void {
    const extras = (['pix', 'boleto', 'card'] as const).filter((k) => cmd[k] !== undefined && k !== methodKey(cmd.method));
    if (extras.length > 0) throw new ValidationError(`Opções incompatíveis com method=${cmd.method}: ${extras.join(', ')}`);

    if (cmd.method === PaymentMethod.BOLETO) {
      if (!cmd.boleto) throw new ValidationError('boleto é obrigatório quando method=BOLETO');
      if (!cmd.customer.address) throw new ValidationError('customer.address é obrigatório para boleto');
      const days = diffInDays(parseIsoDate(todayBr()), parseIsoDate(cmd.boleto.dueDate));
      if (days < 0) throw new ValidationError('boleto.dueDate não pode estar no passado');
      if (days > MAX_BOLETO_DAYS_AHEAD) throw new ValidationError('boleto.dueDate muito distante');
    }
    if (cmd.method === PaymentMethod.CREDIT_CARD && !cmd.card) throw new ValidationError('card é obrigatório quando method=CREDIT_CARD');
  }

  private async buildChargeRequest(cmd: CreatePaymentCommand, transactionId: string, convenio: Convenio, payer: PayerData): Promise<ChargeRequest> {
    const base = { transactionId, amountCents: cmd.amountCents, description: cmd.description, payer };
    switch (cmd.method) {
      case PaymentMethod.PIX:
        return {
          ...base,
          method: PaymentMethod.PIX,
          txid: transactionId.replace(/-/g, ''), // 32 alfanuméricos: dentro da regra [a-zA-Z0-9]{26,35}
          expiresInSeconds: cmd.pix?.expiresInSeconds ?? DEFAULT_PIX_EXPIRATION,
        };
      case PaymentMethod.BOLETO: {
        const boleto = cmd.boleto!;
        return {
          ...base,
          method: PaymentMethod.BOLETO,
          sequence: await this.convenios.nextNossoNumeroSequence(convenio.id),
          dueDate: parseIsoDate(boleto.dueDate),
          issueDate: parseIsoDate(todayBr()),
          instructions: boleto.instructions,
          finePercent: boleto.finePercent,
          interestMonthlyPercent: boleto.interestMonthlyPercent,
          acceptUntilDaysAfterDue: boleto.acceptUntilDaysAfterDue,
        };
      }
      case PaymentMethod.CREDIT_CARD: {
        const card = cmd.card!;
        return {
          ...base,
          method: PaymentMethod.CREDIT_CARD,
          cardToken: card.token,
          installments: card.installments,
          capture: card.capture,
          softDescriptor: card.softDescriptor,
        };
      }
    }
  }

  private async applyResult(tx: Transaction, result: ChargeResult, cmd: CreatePaymentCommand, gateway: IPaymentGateway): Promise<Transaction> {
    const providerData = result.providerData.boleto
      ? { ...result.providerData, boleto: { ...result.providerData.boleto, instructions: cmd.boleto?.instructions ?? [] } }
      : result.providerData;
    return this.transactions.transition(
      tx.id,
      TransactionStatus.PROCESSING,
      result.status,
      {
        providerReference: result.providerReference,
        providerData: providerData as Prisma.InputJsonObject,
        expiresAt: result.expiresAt,
        paidAt: result.paidAt,
        paidAmountCents: result.paidAmountCents,
        failureCode: result.failure?.code ?? null,
        failureMessage: result.failure?.message ?? null,
        lastSyncedAt: new Date(),
      },
      { type: 'charge.registered', source: TransactionEventSource.API, data: { provider: gateway.provider, status: result.status } },
    );
  }

  /**
   * - Resultado INCERTO (timeout/5xx): mantém PROCESSING — a reconciliação consulta o banco depois.
   * - Recusa/erro antes do envio: FAILED com o código do erro.
   * - Erro desconhecido: tratado como incerto (nunca assumir que não cobrou).
   */
  private async handleChargeFailure(tx: Transaction, err: unknown, log: Record<string, unknown>): Promise<void> {
    const uncertain = !(err instanceof AppError) || (err instanceof BankIntegrationError && err.outcome === 'UNCERTAIN');
    try {
      if (uncertain) {
        this.logger.error({ msg: 'charge outcome uncertain; left for reconciliation', ...log, err });
        await this.transactions.recordEvent(tx.id, {
          type: 'charge.uncertain',
          source: TransactionEventSource.API,
          data: { code: err instanceof AppError ? err.code : 'UNKNOWN' },
        });
        return;
      }
      const appErr = err as AppError;
      const bank = err instanceof BankIntegrationError ? err : undefined;
      this.logger.warn({ msg: 'charge failed', ...log, code: appErr.code, bankErrorCode: bank?.bankErrorCode });
      await this.transactions.transition(
        tx.id,
        TransactionStatus.PROCESSING,
        TransactionStatus.FAILED,
        {
          failureCode: (bank?.bankErrorCode ? `${appErr.code}:${bank.bankErrorCode}` : appErr.code).slice(0, 64),
          failureMessage: (bank?.bankMessage ?? appErr.message).slice(0, 500),
        },
        { type: 'charge.failed', source: TransactionEventSource.API, data: { code: appErr.code, outcome: bank?.outcome ?? 'NOT_PROCESSED' } },
      );
    } catch (persistErr) {
      // Não mascara o erro original; a transação fica PROCESSING e será reconciliada.
      this.logger.error({ msg: 'failed to persist charge failure', ...log, err: persistErr });
    }
  }
}

function methodKey(method: PaymentMethod): 'pix' | 'boleto' | 'card' {
  return method === PaymentMethod.PIX ? 'pix' : method === PaymentMethod.BOLETO ? 'boleto' : 'card';
}
