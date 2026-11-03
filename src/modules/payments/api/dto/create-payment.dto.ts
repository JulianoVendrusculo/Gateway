import { PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_AMOUNT_CENTS } from '../../../../common/utils/money';
import { sanitizeText } from '../../../../common/utils/text';
import { IsBrazilianDocument, IsMetadataRecord, NormalizeDocument, Sanitize } from '../../../../common/validation/decorators';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
// Letras (inclusive acentuadas), dígitos e pontuação comum em nomes/endereços — bloqueia <, >, {, }, etc.
const SAFE_TEXT = /^[\p{L}\p{N} .,'ºª°&()/\-]+$/u;

export class AddressDto {
  @IsString() @Sanitize() @Length(1, 120) @Matches(SAFE_TEXT)
  street!: string;

  @IsString() @Sanitize() @Length(1, 10) @Matches(/^[\p{L}\p{N} /-]+$/u)
  number!: string;

  @IsOptional() @IsString() @Sanitize() @MaxLength(60) @Matches(SAFE_TEXT)
  complement?: string;

  @IsString() @Sanitize() @Length(1, 60) @Matches(SAFE_TEXT)
  neighborhood!: string;

  @IsString() @Sanitize() @Length(1, 60) @Matches(SAFE_TEXT)
  city!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(UFS)
  state!: string;

  @Matches(/^\d{5}-?\d{3}$/, { message: 'zipCode deve ser um CEP válido' })
  zipCode!: string;
}

export class CustomerDto {
  @IsString() @Sanitize() @Length(2, 140) @Matches(SAFE_TEXT, { message: 'name contém caracteres não permitidos' })
  name!: string;

  @NormalizeDocument()
  @IsBrazilianDocument()
  document!: string;

  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value))
  @Matches(/^\+?\d{10,14}$/, { message: 'phone deve conter de 10 a 14 dígitos' })
  phone?: string;

  @IsOptional() @ValidateNested() @Type(() => AddressDto)
  address?: AddressDto;
}

export class PixOptionsDto {
  /** Validade do QR Code dinâmico (padrão: 1h; máx.: 30 dias). */
  @IsOptional() @IsInt() @Min(60) @Max(30 * 24 * 3600)
  expiresInSeconds?: number;
}

export class BoletoOptionsDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate deve estar no formato YYYY-MM-DD' })
  dueDate!: string;

  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) @MaxLength(80, { each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? sanitizeText(v) : v)) : value))
  instructions?: string[];

  /** Multa por atraso (%) — limitada a 2% (CDC, art. 52, §1º). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(2)
  finePercent?: number;

  /** Juros de mora ao mês (%). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1)
  interestMonthlyPercent?: number;

  @IsOptional() @IsInt() @Min(0) @Max(60)
  acceptUntilDaysAfterDue?: number;
}

export class CardPaymentDto {
  /** Token emitido pela adquirente (POST /v1/cards/tokens ou SDK client-side). O PAN nunca é aceito aqui. */
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,128}$/)
  token!: string;

  @IsOptional() @IsInt() @Min(1) @Max(12)
  installments?: number;

  /** false = apenas pré-autoriza (captura posterior). */
  @IsOptional() @IsBoolean()
  capture?: boolean;

  @IsOptional() @Matches(/^[A-Za-z0-9 ]{1,13}$/)
  softDescriptor?: string;
}

export class CreatePaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Valor em CENTAVOS (inteiro). Ex.: 15050 = R$ 150,50. */
  @IsInt() @Min(1) @Max(MAX_AMOUNT_CENTS)
  amount!: number;

  @IsOptional() @IsString() @Sanitize() @MaxLength(140)
  description?: string;

  /** Identificador do pedido no sistema do lojista. */
  @IsOptional() @Matches(/^[A-Za-z0-9_.:-]{1,64}$/)
  externalReference?: string;

  /** Força um convênio específico; se omitido, usa o de maior prioridade apto ao método. */
  @IsOptional() @IsUUID()
  convenioId?: string;

  @IsDefined() @ValidateNested() @Type(() => CustomerDto)
  customer!: CustomerDto;

  @IsOptional() @ValidateNested() @Type(() => PixOptionsDto)
  pix?: PixOptionsDto;

  @ValidateIf((o: CreatePaymentDto) => o.method === PaymentMethod.BOLETO || o.boleto !== undefined)
  @IsDefined() @ValidateNested() @Type(() => BoletoOptionsDto)
  boleto?: BoletoOptionsDto;

  @ValidateIf((o: CreatePaymentDto) => o.method === PaymentMethod.CREDIT_CARD || o.card !== undefined)
  @IsDefined() @ValidateNested() @Type(() => CardPaymentDto)
  card?: CardPaymentDto;

  @IsOptional() @IsMetadataRecord()
  metadata?: Record<string, string | number | boolean>;
}
