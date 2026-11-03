import { Module } from '@nestjs/common';
import { ConveniosModule } from '../convenios/convenios.module';
import { CustomersModule } from '../customers/customers.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { CardsController } from './api/cards.controller';
import { PaymentsController } from './api/payments.controller';
import { ConvenioResolver } from './application/convenio-resolver';
import { GatewayContextFactory } from './application/gateway-context.factory';
import { GetPaymentUseCase } from './application/get-payment.use-case';
import { PaymentPresenter } from './application/payment.presenter';
import { ProcessPaymentUseCase } from './application/process-payment.use-case';
import { SyncPaymentStatusUseCase } from './application/sync-payment-status.use-case';
import { TokenizeCardUseCase } from './application/tokenize-card.use-case';
import { TransactionRepository } from './application/transaction.repository';
import { GatewaysModule } from './gateways/gateways.module';
import { ReconciliationJob } from './reconciliation/reconciliation.job';

@Module({
  imports: [GatewaysModule, ConveniosModule, CustomersModule, IdempotencyModule],
  controllers: [PaymentsController, CardsController],
  providers: [
    ConvenioResolver,
    GatewayContextFactory,
    TransactionRepository,
    PaymentPresenter,
    ProcessPaymentUseCase,
    GetPaymentUseCase,
    SyncPaymentStatusUseCase,
    TokenizeCardUseCase,
    ReconciliationJob,
  ],
  exports: [SyncPaymentStatusUseCase, TransactionRepository, GatewaysModule],
})
export class PaymentsModule {}
