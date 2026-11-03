import { Injectable, Logger } from '@nestjs/common';
import { Convenio, PaymentMethod, Prisma, ProviderEnvironment } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ConvenioValidationError, ResourceNotFoundError } from '../../common/errors';
import { maskSecret } from '../../common/utils/text';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../infra/database/prisma.service';
import { CertificateInfo, InvalidCertificateError, MtlsMaterial, inspectClientCertificate } from '../../infra/http/mtls-material';
import { assertAllowedBankUrl } from '../../infra/http/url-guard';
import { ConvenioCredentials, ValidatedConvenioConfig } from '../payments/domain/payment-gateway.port';
import { PaymentGatewayRegistry } from '../payments/gateways/payment-gateway.registry';
import { ConvenioVault, StoredCertificate, toMtlsMaterial } from './convenio-vault.service';
import { CertificateDto, CreateConvenioDto, RotateCredentialsDto, UpdateConvenioDto } from './dto/convenio.dto';

export interface ConvenioView {
  id: string;
  merchantId: string;
  provider: string;
  environment: string;
  label: string;
  supportedMethods: PaymentMethod[];
  priority: number;
  isActive: boolean;
  settings: unknown;
  /** Apenas máscara/presença — segredos nunca saem da API. */
  credentials: Record<string, string | undefined>;
  certificate: { fingerprint: string | null; subject: string | null; expiresAt: Date | null } | null;
  credentialsVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ConveniosService {
  private readonly logger = new Logger(ConveniosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
    private readonly vault: ConvenioVault,
    private readonly config: AppConfig,
  ) {}

  async create(merchantId: string, dto: CreateConvenioDto): Promise<ConvenioView> {
    await this.ensureMerchant(merchantId);
    const certificate = dto.certificate ? this.toStoredCertificate(dto.certificate) : undefined;
    const certInfo = certificate ? this.inspect(certificate) : undefined;
    const validated = this.validate(dto.provider, dto.environment, dto.supportedMethods, dto.settings, dto.credentials, !!certificate);

    const id = randomUUID();
    const convenio = await this.prisma.convenio.create({
      data: {
        id,
        merchantId,
        provider: dto.provider,
        environment: dto.environment,
        label: dto.label,
        supportedMethods: dto.supportedMethods,
        priority: dto.priority ?? 0,
        settings: validated.settings as Prisma.InputJsonObject,
        credentialsCiphertext: this.vault.sealCredentials(id, validated.credentials),
        certificateCiphertext: certificate ? this.vault.sealCertificate(id, certificate) : null,
        encryptionKeyId: this.vault.activeKeyId,
        ...this.certificateColumns(certInfo),
        nossoNumeroSequence: BigInt(dto.nossoNumeroStart ?? 0),
      },
    });
    this.logger.log({ msg: 'convenio created', convenioId: id, merchantId, provider: dto.provider, environment: dto.environment });
    return this.present(convenio);
  }

  async list(merchantId: string): Promise<ConvenioView[]> {
    await this.ensureMerchant(merchantId);
    const items = await this.prisma.convenio.findMany({ where: { merchantId }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
    return items.map((c) => this.present(c));
  }

  async get(id: string): Promise<ConvenioView> {
    return this.present(await this.find(id));
  }

  async update(id: string, dto: UpdateConvenioDto): Promise<ConvenioView> {
    const current = await this.find(id);
    let settings: Prisma.InputJsonObject | undefined;
    if (dto.settings !== undefined || dto.supportedMethods !== undefined) {
      const validated = this.validate(
        current.provider,
        current.environment,
        dto.supportedMethods ?? current.supportedMethods,
        dto.settings ?? (current.settings as Record<string, unknown>),
        this.vault.openCredentials(current),
        !!current.certificateCiphertext,
      );
      settings = validated.settings as Prisma.InputJsonObject;
    }
    const updated = await this.prisma.convenio.update({
      where: { id },
      data: {
        label: dto.label,
        priority: dto.priority,
        isActive: dto.isActive,
        supportedMethods: dto.supportedMethods,
        settings,
      },
    });
    this.logger.log({ msg: 'convenio updated', convenioId: id, fields: Object.keys(dto) });
    return this.present(updated);
  }

  /** Rotação de credenciais/certificado: re-valida, re-cifra com a chave ativa e invalida caches. */
  async rotateCredentials(id: string, dto: RotateCredentialsDto): Promise<ConvenioView> {
    const current = await this.find(id);
    let certificateCiphertext: string | null | undefined;
    let certInfo: CertificateInfo | undefined;
    if (dto.certificate) {
      const cert = this.toStoredCertificate(dto.certificate);
      certInfo = this.inspect(cert);
      certificateCiphertext = this.vault.sealCertificate(id, cert);
    } else if (dto.removeCertificate) {
      certificateCiphertext = null;
    } else if (current.certificateCiphertext) {
      // Re-cifra o certificado existente com a chave ativa (rotação de chave de dados).
      const existing = this.vault.openCertificate(current);
      certificateCiphertext = existing ? this.vault.sealCertificate(id, toStored(existing)) : null;
    }
    const hasCertificate = typeof certificateCiphertext === 'string';
    const validated = this.validate(current.provider, current.environment, current.supportedMethods, current.settings, dto.credentials, hasCertificate);

    const updated = await this.prisma.convenio.update({
      where: { id },
      data: {
        credentialsCiphertext: this.vault.sealCredentials(id, validated.credentials),
        certificateCiphertext,
        encryptionKeyId: this.vault.activeKeyId,
        credentialsVersion: { increment: 1 },
        ...(certInfo ? this.certificateColumns(certInfo) : {}),
        ...(certificateCiphertext === null ? this.certificateColumns(undefined) : {}),
      },
    });
    this.logger.log({ msg: 'convenio credentials rotated', convenioId: id, credentialsVersion: updated.credentialsVersion });
    return this.present(updated);
  }

  /** Incremento atômico (UPDATE ... SET seq = seq + 1 RETURNING) — seguro sob concorrência. */
  async nextNossoNumeroSequence(convenioId: string): Promise<bigint> {
    const { nossoNumeroSequence } = await this.prisma.convenio.update({
      where: { id: convenioId },
      data: { nossoNumeroSequence: { increment: 1 } },
      select: { nossoNumeroSequence: true },
    });
    return nossoNumeroSequence;
  }

  // ---------------------------------------------------------------------------

  private validate(
    provider: Convenio['provider'],
    environment: ProviderEnvironment,
    supportedMethods: PaymentMethod[],
    settings: unknown,
    credentials: unknown,
    hasCertificate: boolean,
  ): ValidatedConvenioConfig {
    const gateway = this.registry.get(provider);
    const unsupported = supportedMethods.filter((m) => !gateway.supportedMethods.has(m));
    if (unsupported.length > 0) {
      throw new ConvenioValidationError(`O provedor ${provider} não suporta: ${unsupported.join(', ')}`);
    }
    const validated = gateway.validateConvenio({ environment, supportedMethods, settings, credentials, hasCertificate });
    const allowedHosts = this.config.get('BANK_URL_ALLOWED_HOSTS');
    for (const url of validated.urls) {
      try {
        assertAllowedBankUrl(url, allowedHosts);
      } catch (err) {
        throw new ConvenioValidationError('URL de integração não permitida', { details: { issues: [(err as Error).message] } });
      }
    }
    return validated;
  }

  private toStoredCertificate(dto: CertificateDto): StoredCertificate {
    return dto.format === 'PFX'
      ? { format: 'PFX', pfxBase64: dto.pfxBase64, passphrase: dto.passphrase, caPem: dto.caPem }
      : { format: 'PEM', certPem: dto.certPem, keyPem: dto.keyPem, passphrase: dto.passphrase, caPem: dto.caPem };
  }

  private inspect(cert: StoredCertificate): CertificateInfo {
    try {
      return inspectClientCertificate(toMtlsMaterial(cert));
    } catch (err) {
      if (err instanceof InvalidCertificateError) {
        throw new ConvenioValidationError('Certificado mTLS inválido', { details: { issues: [err.message] } });
      }
      throw err;
    }
  }

  private certificateColumns(info: CertificateInfo | undefined) {
    return {
      certificateFingerprint: info?.fingerprint256 ?? null,
      certificateSubject: info?.subject.slice(0, 512) ?? null,
      certificateExpiresAt: info?.validTo ?? null,
    };
  }

  private async find(id: string): Promise<Convenio> {
    const convenio = await this.prisma.convenio.findUnique({ where: { id } });
    if (!convenio) throw new ResourceNotFoundError('Convênio');
    return convenio;
  }

  private async ensureMerchant(merchantId: string): Promise<void> {
    const exists = await this.prisma.merchant.count({ where: { id: merchantId } });
    if (!exists) throw new ResourceNotFoundError('Lojista');
  }

  private present(c: Convenio): ConvenioView {
    const creds: ConvenioCredentials = this.vault.openCredentials(c);
    return {
      id: c.id,
      merchantId: c.merchantId,
      provider: c.provider,
      environment: c.environment,
      label: c.label,
      supportedMethods: c.supportedMethods,
      priority: c.priority,
      isActive: c.isActive,
      settings: c.settings,
      credentials: {
        clientId: maskSecret(creds.clientId),
        clientSecret: creds.clientSecret ? '********' : undefined,
        developerAppKey: maskSecret(creds.developerAppKey),
        pixKey: maskSecret(creds.pixKey),
        acquirerToken: creds.acquirerToken ? '********' : undefined,
      },
      certificate: c.certificateCiphertext
        ? { fingerprint: c.certificateFingerprint, subject: c.certificateSubject, expiresAt: c.certificateExpiresAt }
        : null,
      credentialsVersion: c.credentialsVersion,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}

function toStored(m: MtlsMaterial): StoredCertificate {
  return {
    format: m.format,
    certPem: m.certPem,
    keyPem: m.keyPem,
    pfxBase64: m.pfx?.toString('base64'),
    passphrase: m.passphrase,
    caPem: m.caPem,
  };
}
