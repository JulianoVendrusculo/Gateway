import { PaymentMethod, PaymentProvider, ProviderEnvironment } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBase64,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Sanitize } from '../../../common/validation/decorators';

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

export class CertificateDto {
  @IsIn(['PEM', 'PFX'])
  format!: 'PEM' | 'PFX';

  @ValidateIf((o: CertificateDto) => o.format === 'PEM')
  @IsString()
  @MaxLength(20_000)
  @Matches(PEM_CERT, { message: 'certPem deve estar em formato PEM' })
  certPem?: string;

  @ValidateIf((o: CertificateDto) => o.format === 'PEM')
  @IsString()
  @MaxLength(20_000)
  @Matches(PEM_KEY, { message: 'keyPem deve estar em formato PEM' })
  keyPem?: string;

  @ValidateIf((o: CertificateDto) => o.format === 'PFX')
  @IsBase64()
  @MaxLength(60_000)
  pfxBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  passphrase?: string;

  /** CA adicional para validar o servidor do banco (somada às raízes públicas). */
  @IsOptional()
  @IsString()
  @MaxLength(60_000)
  @Matches(PEM_CERT, { message: 'caPem deve estar em formato PEM' })
  caPem?: string;
}

export class CreateConvenioDto {
  @IsEnum(PaymentProvider)
  provider!: PaymentProvider;

  @IsEnum(ProviderEnvironment)
  environment!: ProviderEnvironment;

  @IsString()
  @Sanitize()
  @Length(1, 80)
  label!: string;

  @IsEnum(PaymentMethod, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  supportedMethods!: PaymentMethod[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  /** Parâmetros não sensíveis específicos do provedor (validados pelo adapter). */
  @IsObject()
  settings!: Record<string, unknown>;

  /** Segredos — cifrados com AES-256-GCM antes de persistir; nunca retornados pela API. */
  @IsObject()
  credentials!: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => CertificateDto)
  certificate?: CertificateDto;

  /** Ponto de partida do sequencial de nosso número (evita colisão com títulos emitidos fora do gateway). */
  @IsOptional()
  @IsInt()
  @Min(0)
  nossoNumeroStart?: number;
}

export class UpdateConvenioDto {
  @IsOptional()
  @IsString()
  @Sanitize()
  @Length(1, 80)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsEnum(PaymentMethod, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  supportedMethods?: PaymentMethod[];

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class RotateCredentialsDto {
  @IsObject()
  credentials!: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => CertificateDto)
  certificate?: CertificateDto;

  /** true remove o certificado atual (sem enviar um novo). */
  @IsOptional()
  @IsBoolean()
  removeCertificate?: boolean;
}
