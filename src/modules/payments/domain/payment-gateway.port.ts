import { PaymentMethod, PaymentProvider, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { BankIntegrationError } from '../../../common/errors';
import { BankHttpClient } from '../../../infra/http/bank-http-client';

// =============================================================================
// Port (Hexagonal) — contrato único que todo provedor (banco/adquirente) implementa.
// O núcleo da aplicação só conhece esta interface; o adapter concreto é escolhido
// em runtime a partir do convênio da transação (Strategy).
//
// v2 (cobrança única): além de criar a cobrança, todo provedor precisa saber
// CONSULTAR (getStatus) e CANCELAR (cancel) uma tentativa. É isso que permite trocar
// de método com segurança e nunca liberar uma tentativa que ainda pode ser paga.
// =============================================================================

/** Credenciais do convênio já decifradas — vivem apenas em memória durante a operação. */
export interface ConvenioCredentials {
  clientId?: string;
  clientSecret?: string;
  /** BB: "gw-dev-app-key" (developer application key). */
  developerAppKey?: string;
  pixKey?: string;
  /** Token/chave de integração da adquirente de cartão. */
  acquirerToken?: string;
}

export interface GatewayContext {
  convenioId: string;
  credentialsVersion: number;
  environment: ProviderEnvironment;
  /** Configurações não sensíveis (validadas pelo próprio adapter). */
  settings: Record<string, unknown>;
  credentials: ConvenioCredentials;
  /** Cliente HTTP já amarrado ao certificado mTLS do convênio. */
  http: BankHttpClient;
  /** Beneficiário/recebedor (o lojista). */
  beneficiary: { name: string; document: string };
}

export interface PayerAddress {
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface PayerData {
  name: string;
  document: string;
  documentType: 'CPF' | 'CNPJ';
  email?: string;
  phone?: string;
  address?: PayerAddress;
}

interface BaseChargeRequest {
  transactionId: string;
  amountCents: number;
  description?: string;
  payer: PayerData;
}

export interface PixChargeRequest extends BaseChargeRequest {
  method: typeof PaymentMethod.PIX;
  /** txid gerado pelo gateway (26–35 alfanuméricos) — torna a criação idempotente no PSP. */
  txid: string;
  expiresInSeconds: number;
}

export interface BoletoChargeRequest extends BaseChargeRequest {
  method: typeof PaymentMethod.BOLETO;
  /** Sequencial atômico do convênio usado para compor o "nosso número". */
  sequence: bigint;
  /** Data civil (UTC 00:00). */
  dueDate: Date;
  issueDate: Date;
  instructions: string[];
  finePercent?: number;
  interestMonthlyPercent?: number;
  /** Dias após o vencimento em que o boleto ainda pode ser pago. */
  acceptUntilDaysAfterDue?: number;
}

/**
 * Modos de cartão.
 *  - HOSTED_LINK: o pagador sai da plataforma e paga na página do banco (único modo implementado).
 *  - DIRECT: dados do cartão tokenizados e autorização na própria chamada. Fica só o tipo, para o
 *    contrato não precisar mudar quando um adapter passar a oferecê-lo.
 */
export type CardMode = 'HOSTED_LINK' | 'DIRECT';

export interface HostedLinkCardChargeRequest extends BaseChargeRequest {
  method: typeof PaymentMethod.CREDIT_CARD;
  mode: 'HOSTED_LINK';
  /** Validade do link. Curta de propósito: enquanto ele vale, a cobrança fica presa a este método. */
  linkTtlSeconds: number;
  maxInstallments: number;
  softDescriptor?: string;
}

export interface DirectCardChargeRequest extends BaseChargeRequest {
  method: typeof PaymentMethod.CREDIT_CARD;
  mode: 'DIRECT';
  cardToken: string;
  installments: number;
  softDescriptor?: string;
}

export type CardChargeRequest = HostedLinkCardChargeRequest | DirectCardChargeRequest;

export type ChargeRequest = PixChargeRequest | BoletoChargeRequest | CardChargeRequest;

export interface PixData {
  txid: string;
  copyPaste: string;
  location?: string;
  expiresInSeconds: number;
}

export interface BoletoData {
  nossoNumero: string;
  digitableLine: string;
  barcode: string;
  dueDate: string;
  issueDate: string;
  bankPdfUrl?: string;
  /** Boleto híbrido (BB): QR Code Pix impresso no boleto. */
  pixCopyPaste?: string;
  instructions?: string[];
}

export interface CardData {
  mode: CardMode;
  /** HOSTED_LINK: página do banco para onde o pagador é enviado. */
  paymentUrl?: string;
  maxInstallments?: number;
  /** Preenchidos quando o provedor informa, depois do pagamento. */
  brand?: string;
  last4?: string;
  installments?: number;
  authorizationCode?: string;
  nsu?: string;
}

export interface ProviderData {
  pix?: PixData;
  boleto?: BoletoData;
  card?: CardData;
}

/** Resultado imediato da criação: registrada (aguardando pagamento), já paga, ou recusada. */
export type ChargeResultStatus = Extract<TransactionStatus, 'PENDENTE' | 'CONFIRMADA' | 'FALHOU'>;

/** Um pagamento informado pelo provedor. O `id` é o que distingue dois pagamentos da mesma cobrança. */
export interface ProviderPayment {
  /** endToEndId (Pix), identificador da liquidação (boleto) ou do pagamento (cartão), quando o provedor informa. */
  id?: string;
  amountCents?: number;
  paidAt?: Date;
}

export interface ChargeResult {
  status: ChargeResultStatus;
  providerReference: string;
  providerData: ProviderData;
  expiresAt?: Date;
  /** Presente quando status = CONFIRMADA. */
  payment?: ProviderPayment;
  /** Recusa de negócio — não é exceção, é resultado. */
  failure?: { code: string; message: string };
}

export interface ChargeReference {
  transactionId: string;
  method: PaymentMethod;
  providerReference: string;
  amountCents: number;
  createdAt: Date;
  expiresAt?: Date | null;
}

/** Situação da cobrança NO PROVEDOR, no vocabulário da Transaction. */
export type ProviderChargeStatus = Extract<TransactionStatus, 'PENDENTE' | 'CONFIRMADA' | 'CANCELADA' | 'EXPIRADA'>;

export interface ChargeStatusResult {
  /**
   * PENDENTE: ainda pode ser paga. CONFIRMADA: foi paga. CANCELADA: removida/baixada no provedor.
   * EXPIRADA: o provedor não aceita mais o pagamento.
   */
  status: ProviderChargeStatus;
  /** Status bruto do provedor (para auditoria). */
  providerStatus: string;
  /** Pagamentos recebidos. Mais de um significa pagamento em duplicidade da mesma cobrança. */
  payments?: ProviderPayment[];
  /** Dados da cobrança, quando o provedor os devolve na consulta (preenche transações reconciliadas). */
  providerData?: ProviderData;
  expiresAt?: Date;
}

/**
 * Resultado de um pedido de cancelamento. Nunca é exceção: quem chama precisa tratar os casos.
 * Mesmo com CANCELED, a regra de negócio só libera a troca de método depois de getStatus() confirmar.
 */
export type CancelResult =
  /** O provedor aceitou o cancelamento (ou a cobrança já estava cancelada). */
  | { outcome: 'CANCELED'; providerStatus: string }
  /** Recusado porque a cobrança já foi paga: deve ser tratado como confirmação de pagamento. */
  | { outcome: 'ALREADY_PAID'; providerStatus: string; payments?: ProviderPayment[] }
  /** Recusado por outro motivo de negócio: a cobrança continua podendo ser paga. */
  | { outcome: 'REFUSED'; providerStatus: string; reason?: string }
  /** O provedor não oferece cancelamento para este tipo de cobrança: o bloqueio vale até a expiração. */
  | { outcome: 'NOT_SUPPORTED'; reason: string }
  /** Falha técnica: não se sabe se o cancelamento aconteceu. */
  | { outcome: 'TECHNICAL_ERROR'; error: BankIntegrationError };

export type WebhookEventType = 'PIX_RECEIVED' | 'BOLETO_PAID' | 'BOLETO_WRITTEN_OFF' | 'CARD_PAID' | 'UNKNOWN';

export interface NormalizedWebhookEvent {
  /** Chave natural única do evento (deduplicação). */
  eventKey: string;
  type: WebhookEventType;
  providerReference: string;
  /** Identificador do pagamento a que o evento se refere, quando o provedor informa. */
  paymentId?: string;
  amountCents?: number;
  occurredAt?: Date;
  /** Desambiguação quando a referência só é única por convênio (ex.: nosso número). */
  convenioHint?: { settingsKey: string; value: string | number };
  /** Fragmento do payload referente a este evento (auditoria). */
  raw: unknown;
}

export interface ConvenioValidationInput {
  environment: ProviderEnvironment;
  supportedMethods: PaymentMethod[];
  settings: unknown;
  credentials: unknown;
  hasCertificate: boolean;
}

export interface ValidatedConvenioConfig {
  settings: Record<string, unknown>;
  credentials: ConvenioCredentials;
  /** URLs configuradas (sujeitas à allowlist anti-SSRF). */
  urls: string[];
}

export interface IPaymentGateway {
  readonly provider: PaymentProvider;
  readonly supportedMethods: ReadonlySet<PaymentMethod>;
  /** Modos de cartão oferecidos. Ausente ou vazio = o provedor não processa cartão. */
  readonly cardModes?: ReadonlySet<CardMode>;

  /** Valida settings/credenciais específicos do provedor no cadastro do convênio. */
  validateConvenio(input: ConvenioValidationInput): ValidatedConvenioConfig;

  /**
   * Referência determinística conhecida ANTES do envio (txid, nosso número, id do pedido na adquirente),
   * persistida junto da transação. Permite reconciliar operações com resultado incerto (timeout):
   * sem ela a transação ficaria PROCESSANDO para sempre.
   */
  providerReferenceFor(ctx: GatewayContext, request: ChargeRequest): string | undefined;

  createCharge(ctx: GatewayContext, request: ChargeRequest): Promise<ChargeResult>;

  /** Consulta autoritativa no provedor. É a única fonte que confirma pagamento ou cancelamento. */
  getStatus(ctx: GatewayContext, ref: ChargeReference): Promise<ChargeStatusResult>;

  /** Pede o cancelamento da cobrança no provedor. Ver CancelResult. */
  cancel(ctx: GatewayContext, ref: ChargeReference): Promise<CancelResult>;

  /** Converte o payload bruto do webhook em eventos normalizados (sem I/O). */
  parseWebhook(payload: unknown): NormalizedWebhookEvent[];
}
