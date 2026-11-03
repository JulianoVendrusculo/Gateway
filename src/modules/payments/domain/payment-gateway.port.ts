import { PaymentMethod, PaymentProvider, ProviderEnvironment, TransactionStatus } from '@prisma/client';
import { BankHttpClient } from '../../../infra/http/bank-http-client';

// =============================================================================
// Port (Hexagonal) — contrato único que todo provedor (banco/adquirente) implementa.
// O núcleo da aplicação só conhece esta interface; o adapter concreto é escolhido
// em runtime a partir do convênio da transação (Strategy).
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

export interface CardChargeRequest extends BaseChargeRequest {
  method: typeof PaymentMethod.CREDIT_CARD;
  cardToken: string;
  installments: number;
  capture: boolean;
  softDescriptor?: string;
}

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
  brand: string;
  last4: string;
  installments: number;
  authorizationCode?: string;
  nsu?: string;
  tid?: string;
}

export interface ProviderData {
  pix?: PixData;
  boleto?: BoletoData;
  card?: CardData;
}

export type ChargeResultStatus = Extract<TransactionStatus, 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED'>;

export interface ChargeResult {
  status: ChargeResultStatus;
  providerReference: string;
  providerData: ProviderData;
  expiresAt?: Date;
  paidAt?: Date;
  paidAmountCents?: number;
  /** Recusa de negócio (ex.: cartão negado) — não é exceção, é resultado. */
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

export interface ChargeStatusResult {
  status: TransactionStatus;
  /** Status bruto do provedor (para auditoria). */
  providerStatus: string;
  paidAmountCents?: number;
  paidAt?: Date;
  /** Dados da cobrança, quando o provedor os devolve na consulta (preenche transações reconciliadas). */
  providerData?: ProviderData;
  expiresAt?: Date;
}

export type WebhookEventType = 'PIX_RECEIVED' | 'BOLETO_PAID' | 'BOLETO_WRITTEN_OFF' | 'UNKNOWN';

export interface NormalizedWebhookEvent {
  /** Chave natural única do evento (deduplicação). */
  eventKey: string;
  type: WebhookEventType;
  providerReference: string;
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

  /** Valida settings/credenciais específicos do provedor no cadastro do convênio. */
  validateConvenio(input: ConvenioValidationInput): ValidatedConvenioConfig;

  /**
   * Referência determinística conhecida ANTES do envio (txid, nosso número), persistida
   * junto da transação. Permite reconciliar operações com resultado incerto (timeout).
   */
  providerReferenceFor(ctx: GatewayContext, request: ChargeRequest): string | undefined;

  createCharge(ctx: GatewayContext, request: ChargeRequest): Promise<ChargeResult>;

  /** Consulta autoritativa no provedor (usada por webhook e reconciliação). */
  getChargeStatus(ctx: GatewayContext, ref: ChargeReference): Promise<ChargeStatusResult>;

  /** Converte o payload bruto do webhook em eventos normalizados (sem I/O). */
  parseWebhook(payload: unknown): NormalizedWebhookEvent[];
}

// ---------------------------------------------------------------------------
// Capacidade opcional: tokenização de cartão (PCI-DSS)
// ---------------------------------------------------------------------------

export interface RawCardData {
  number: string;
  holderName: string;
  expMonth: number;
  expYear: number;
  cvv: string;
}

export interface CardTokenResult {
  token: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** Hash estável do cartão para antifraude/deduplicação (nunca o PAN). */
  fingerprint: string;
}

export interface ICardTokenizer {
  tokenizeCard(ctx: GatewayContext, card: RawCardData): Promise<CardTokenResult>;
}

export function isCardTokenizer(gateway: IPaymentGateway): gateway is IPaymentGateway & ICardTokenizer {
  return typeof (gateway as Partial<ICardTokenizer>).tokenizeCard === 'function';
}
