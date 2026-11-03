import { Injectable } from '@nestjs/common';
import { Customer, PaymentMethod, Transaction, TransactionStatus } from '@prisma/client';
import { formatDigitableLine } from '../boleto/boleto-barcode';
import { ProviderData } from '../domain/payment-gateway.port';
import { pixQrCodeDataUrl } from '../pix/pix-qrcode';

export interface PaymentView {
  id: string;
  status: TransactionStatus;
  method: PaymentMethod;
  provider: string;
  convenioId: string;
  amount: number;
  paidAmount: number | null;
  currency: string;
  description: string | null;
  externalReference: string | null;
  customer: { id: string; name: string; document: string };
  pix?: { txid: string; copyPaste: string; qrCodeImage?: string; expiresAt: string | null };
  boleto?: {
    nossoNumero: string;
    digitableLine: string;
    digitableLineFormatted: string;
    barcode: string;
    dueDate: string;
    pdfUrl: string;
    pixCopyPaste?: string;
  };
  card?: { brand: string; last4: string; installments: number; authorizationCode?: string };
  failure: { code: string; message: string | null } | null;
  metadata: unknown;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Monta a resposta pública. Nunca expõe dados internos (credenciais, PII completa, ids de convênio sensíveis). */
@Injectable()
export class PaymentPresenter {
  async present(tx: Transaction, customer: Customer): Promise<PaymentView> {
    const data = (tx.providerData ?? {}) as ProviderData;
    const view: PaymentView = {
      id: tx.id,
      status: tx.status,
      method: tx.method,
      provider: tx.provider,
      convenioId: tx.convenioId,
      amount: tx.amountCents,
      paidAmount: tx.paidAmountCents,
      currency: tx.currency,
      description: tx.description,
      externalReference: tx.externalReference,
      customer: { id: customer.id, name: customer.name, document: customer.documentMasked },
      failure: tx.failureCode ? { code: tx.failureCode, message: tx.failureMessage } : null,
      metadata: tx.metadata ?? null,
      expiresAt: tx.expiresAt?.toISOString() ?? null,
      paidAt: tx.paidAt?.toISOString() ?? null,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
    };
    if (data.pix) {
      view.pix = {
        txid: data.pix.txid,
        copyPaste: data.pix.copyPaste,
        expiresAt: tx.expiresAt?.toISOString() ?? null,
        // QR Code só faz sentido enquanto a cobrança está aberta; gerado sob demanda.
        ...(tx.status === TransactionStatus.PENDING ? { qrCodeImage: await pixQrCodeDataUrl(data.pix.copyPaste) } : {}),
      };
    }
    if (data.boleto) {
      view.boleto = {
        nossoNumero: data.boleto.nossoNumero,
        digitableLine: data.boleto.digitableLine,
        digitableLineFormatted: formatDigitableLine(data.boleto.digitableLine),
        barcode: data.boleto.barcode,
        dueDate: data.boleto.dueDate,
        pdfUrl: `/v1/payments/${tx.id}/boleto.pdf`,
        ...(data.boleto.pixCopyPaste ? { pixCopyPaste: data.boleto.pixCopyPaste } : {}),
      };
    }
    if (data.card) {
      view.card = {
        brand: data.card.brand,
        last4: data.card.last4,
        installments: data.card.installments,
        authorizationCode: data.card.authorizationCode,
      };
    }
    return view;
  }
}
