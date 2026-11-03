import { Injectable, Logger } from '@nestjs/common';
import { Convenio } from '@prisma/client';
import { ConvenioMisconfiguredError } from '../../../common/errors';
import { BankHttpClientFactory } from '../../../infra/http/bank-http-client.factory';
import { MtlsMaterial } from '../../../infra/http/mtls-material';
import { ConvenioVault } from '../../convenios/convenio-vault.service';
import { ConvenioCredentials, GatewayContext } from '../domain/payment-gateway.port';

const CERT_EXPIRY_WARNING_MS = 30 * 86_400_000;

/**
 * Monta o contexto de execução do adapter: decifra credenciais/certificado (apenas em memória)
 * e entrega um cliente HTTP já amarrado ao certificado mTLS do convênio.
 */
@Injectable()
export class GatewayContextFactory {
  private readonly logger = new Logger(GatewayContextFactory.name);

  constructor(
    private readonly vault: ConvenioVault,
    private readonly httpFactory: BankHttpClientFactory,
  ) {}

  build(convenio: Convenio, beneficiary: { name: string; document: string }): GatewayContext {
    const expiresAt = convenio.certificateExpiresAt;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new ConvenioMisconfiguredError(convenio.id, 'certificado mTLS expirado');
    }
    if (expiresAt && expiresAt.getTime() - Date.now() < CERT_EXPIRY_WARNING_MS) {
      this.logger.warn({ msg: 'convenio certificate expiring soon', convenioId: convenio.id, expiresAt });
    }

    let credentials: ConvenioCredentials;
    let mtls: MtlsMaterial | undefined;
    try {
      credentials = this.vault.openCredentials(convenio);
      mtls = this.vault.openCertificate(convenio);
    } catch (cause) {
      throw new ConvenioMisconfiguredError(convenio.id, 'falha ao decifrar credenciais', { cause });
    }

    return {
      convenioId: convenio.id,
      credentialsVersion: convenio.credentialsVersion,
      environment: convenio.environment,
      settings: (convenio.settings ?? {}) as Record<string, unknown>,
      credentials,
      http: this.httpFactory.create({ provider: convenio.provider, cacheKey: `${convenio.id}:v${convenio.credentialsVersion}`, mtls }),
      beneficiary,
    };
  }
}
