import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../../auth/api-key.guard';
import { AuthenticatedMerchant } from '../../auth/authenticated-merchant';
import { CurrentMerchant } from '../../auth/current-merchant.decorator';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { GetPaymentUseCase } from '../application/get-payment.use-case';
import { PaymentView } from '../application/payment.presenter';
import { ProcessPaymentUseCase } from '../application/process-payment.use-case';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Controller('v1/payments')
@UseGuards(ApiKeyGuard)
export class PaymentsController {
  constructor(
    private readonly processPayment: ProcessPaymentUseCase,
    private readonly getPayment: GetPaymentUseCase,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Cria uma cobrança (PIX | BOLETO | CREDIT_CARD).
   * Header obrigatório: Idempotency-Key. Repetições com a mesma chave devolvem a resposta original.
   */
  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentMerchant() merchant: AuthenticatedMerchant,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreatePaymentDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.idempotency.execute(
      { merchantId: merchant.id, key: idempotencyKey, scope: 'POST /v1/payments', payload: dto, requestId: String(req.id) },
      async () => {
        const view = await this.processPayment.execute({
          merchant,
          idempotencyKey: idempotencyKey!,
          method: dto.method,
          amountCents: dto.amount,
          description: dto.description,
          externalReference: dto.externalReference,
          convenioId: dto.convenioId,
          customer: {
            name: dto.customer.name,
            document: dto.customer.document,
            documentType: dto.customer.document.length === 11 ? 'CPF' : 'CNPJ',
            email: dto.customer.email?.toLowerCase(),
            phone: dto.customer.phone,
            address: dto.customer.address,
          },
          pix: dto.pix ? { expiresInSeconds: dto.pix.expiresInSeconds ?? 3600 } : undefined,
          boleto: dto.boleto
            ? {
                dueDate: dto.boleto.dueDate,
                instructions: dto.boleto.instructions ?? [],
                finePercent: dto.boleto.finePercent,
                interestMonthlyPercent: dto.boleto.interestMonthlyPercent,
                acceptUntilDaysAfterDue: dto.boleto.acceptUntilDaysAfterDue,
              }
            : undefined,
          card: dto.card
            ? { token: dto.card.token, installments: dto.card.installments ?? 1, capture: dto.card.capture ?? true, softDescriptor: dto.card.softDescriptor }
            : undefined,
          metadata: dto.metadata,
        });
        return { statusCode: 201, body: view, transactionId: view.id };
      },
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.statusCode);
    return result.body;
  }

  /** Consulta status. `?refresh=true` força consulta ao banco antes de responder. */
  @Get(':id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  get(
    @CurrentMerchant() merchant: AuthenticatedMerchant,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('refresh') refresh?: string,
  ): Promise<PaymentView> {
    return this.getPayment.execute(merchant.id, id, refresh === 'true');
  }

  @Get(':id/boleto.pdf')
  @HttpCode(200)
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'private, no-store')
  async boletoPdf(
    @CurrentMerchant() merchant: AuthenticatedMerchant,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { filename, pdf } = await this.getPayment.boletoPdf(merchant.id, id);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return new StreamableFile(pdf);
  }
}
