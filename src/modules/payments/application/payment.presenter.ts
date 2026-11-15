import { Injectable } from '@nestjs/common';
import { Charge, Customer, PaymentMethod, Refund, Transaction, TransactionStatus } from '@prisma/client';
import { formatDigitableLine } from '../boleto/boleto-barcode';
import { ProviderData } from '../domain/payment-gateway.port';
import { isActive } from '../domain/transaction-state-machine';
import { pixQrCodeDataUrl } from '../pix/pix-qrcode';

export interface PaymentView {
  id: string;
  /** Cobrança única a que esta tentativa pertence (nulo em transações da v1). */
  chargeId: string | null;
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
  card?: { mode: string; paymentUrl?: string; maxInstallments?: number; brand?: string; last4?: string; installments?: number; authorizationCode?: string };
  failure: { code: string; message: string | null } | null;
  metadata: unknown;
  expiresAt: string | null;
  /** Enquanto EM_VERIFICACAO: até quando a tentativa segue bloqueando a cobrança. */
  verificationUntil: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChargeView {
  id: string;
  externalReference: string;
  status: string;
  amount: number;
  currency: string;
  expiresAt: string | null;
  paidAt: string | null;
  paidTransactionId: string | null;
  /** true: há uma tentativa em aberto. O front mostra "aguardando confirmação" com `activeAttempt`, sem gerar outra. */
  awaitingConfirmation: boolean;
  /** A tentativa ativa, com o QR Code, o boleto ou o link já emitidos. */
  activeAttempt: PaymentView | null;
  attempts: Array<{ id: string; method: PaymentMethod; status: TransactionStatus; createdAt: string; expiresAt: string | null }>;
  /** Pagamentos recebidos em duplicidade, aguardando análise de estorno. */
  pendingRefunds: Array<{ id: string; transactionId: string; amount: number; status: string; reason: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

const OPEN_FOR_PAYMENT: readonly TransactionStatus[] = [TransactionStatus.PENDENTE, TransactionStatus.PENDING];

/** Monta as respostas públicas. Nunca expõe dados internos (credenciais, PII completa). */
@Injectable()
export class PaymentPresenter {
  async present(tx: Transaction, customer: Customer): Promise<PaymentView> {
    const data = (tx.providerData ?? {}) as ProviderData;
    const payable = OPEN_FOR_PAYMENT.includes(tx.status);
    const view: PaymentView = {
      id: tx.id,
      chargeId: tx.chargeId,
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
      verificationUntil: tx.verificationUntil?.toISOString() ?? null,
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
        ...(payable ? { qrCodeImage: await pixQrCodeDataUrl(data.pix.copyPaste) } : {}),
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
        mode: data.card.mode,
        // O link só é devolvido enquanto pode ser usado.
        ...(payable && data.card.paymentUrl ? { paymentUrl: data.card.paymentUrl } : {}),
        maxInstallments: data.card.maxInstallments,
        brand: data.card.brand,
        last4: data.card.last4,
        installments: data.card.installments,
        authorizationCode: data.card.authorizationCode,
      };
    }
    return view;
  }

  async presentCharge(charge: Charge & { transactions: Array<Transaction & { customer: Customer }>; refunds: Refund[] }): Promise<ChargeView> {
    const active = charge.transactions.find((t) => isActive(t.status));
    return {
      id: charge.id,
      externalReference: charge.externalReference,
      status: charge.status,
      amount: charge.amountCents,
      currency: charge.currency,
      expiresAt: charge.expiresAt?.toISOString() ?? null,
      paidAt: charge.paidAt?.toISOString() ?? null,
      paidTransactionId: charge.paidTransactionId,
      awaitingConfirmation: active !== undefined,
      activeAttempt: active ? await this.present(active, active.customer) : null,
      attempts: charge.transactions.map((t) => ({ id: t.id, method: t.method, status: t.status, createdAt: t.createdAt.toISOString(), expiresAt: t.expiresAt?.toISOString() ?? null })),
      pendingRefunds: charge.refunds.map((r) => ({ id: r.id, transactionId: r.transactionId, amount: r.amountCents, status: r.status, reason: r.reason, createdAt: r.createdAt.toISOString() })),
      createdAt: charge.createdAt.toISOString(),
      updatedAt: charge.updatedAt.toISOString(),
    };
  }
}
