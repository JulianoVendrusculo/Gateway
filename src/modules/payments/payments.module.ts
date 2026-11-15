import { Module } from '@nestjs/common';
import { ConveniosModule } from '../convenios/convenios.module';
import { CustomersModule } from '../customers/customers.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { ChargesController } from './api/charges.controller';
import { PaymentsController } from './api/payments.controller';
import { AttemptLifecycleService } from './application/attempt-lifecycle.service';
import { ChargeRepository } from './application/charge.repository';
import { ConvenioResolver } from './application/convenio-resolver';
import { GatewayContextFactory } from './application/gateway-context.factory';
import { GetPaymentUseCase } from './application/get-payment.use-case';
import { PaymentPresenter } from './application/payment.presenter';
import { PaymentSettlementService } from './application/payment-settlement.service';
import { ProcessPaymentUseCase } from './application/process-payment.use-case';
import { TransactionRepository } from './application/transaction.repository';
import { GatewaysModule } from './gateways/gateways.module';
import { ReconciliationJob } from './reconciliation/reconciliation.job';

@Module({
  imports: [GatewaysModule, ConveniosModule, CustomersModule, IdempotencyModule],
  controllers: [PaymentsController, ChargesController],
  providers: [
    ConvenioResolver,
    GatewayContextFactory,
    TransactionRepository,
    ChargeRepository,
    PaymentSettlementService,
    AttemptLifecycleService,
    PaymentPresenter,
    ProcessPaymentUseCase,
    GetPaymentUseCase,
    ReconciliationJob,
  ],
  exports: [AttemptLifecycleService, GatewaysModule],
})
export class PaymentsModule {}
