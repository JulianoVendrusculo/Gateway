import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PaymentProvider } from '@prisma/client';
import type { Request } from 'express';
import { BlockList, isIP } from 'node:net';
import { UnauthorizedError } from '../../common/errors';
import { AppConfig } from '../../config/app-config';
import { HashingService } from '../../infra/crypto/hashing.service';

export const WEBHOOK_PROVIDER = 'webhook:provider';
export const WebhookProvider = (provider: PaymentProvider) => SetMetadata(WEBHOOK_PROVIDER, provider);

interface ProviderPolicy {
  secret?: string;
  allowedSubjects: string[];
  allowedIps?: BlockList;
}

/**
 * Autenticação de webhooks bancários em camadas (todas as configuradas precisam passar):
 *  1. mTLS: o proxy TLS (nginx/ALB/Envoy) valida o certificado do banco e repassa
 *     o resultado em headers (o proxy DEVE sobrescrever esses headers vindos do cliente).
 *  2. Segredo compartilhado na URL registrada no banco (/t/:token, ?token= ou header).
 *  3. Allowlist de IPs/CIDRs de origem.
 * Mesmo autenticado, o payload nunca é fonte da verdade: o status é reconsultado no banco.
 */
@Injectable()
export class WebhookAuthGuard implements CanActivate {
  private readonly logger = new Logger(WebhookAuthGuard.name);
  private readonly policies: Map<PaymentProvider, ProviderPolicy>;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
  ) {
    this.policies = new Map<PaymentProvider, ProviderPolicy>([
      [
        PaymentProvider.BANCO_DO_BRASIL,
        { secret: config.get('WEBHOOK_SECRET_BB'), allowedSubjects: config.get('WEBHOOK_BB_ALLOWED_SUBJECTS'), allowedIps: buildBlockList(config.get('WEBHOOK_BB_ALLOWED_IPS')) },
      ],
      [
        PaymentProvider.CAIXA,
        { secret: config.get('WEBHOOK_SECRET_CAIXA'), allowedSubjects: config.get('WEBHOOK_CAIXA_ALLOWED_SUBJECTS'), allowedIps: buildBlockList(config.get('WEBHOOK_CAIXA_ALLOWED_IPS')) },
      ],
    ]);
  }

  canActivate(context: ExecutionContext): boolean {
    const provider = this.reflector.get<PaymentProvider>(WEBHOOK_PROVIDER, context.getClass());
    const policy = this.policies.get(provider);
    const req = context.switchToHttp().getRequest<Request>();
    const reject = (reason: string): never => {
      this.logger.warn({ msg: 'webhook rejected', provider, reason, ip: req.ip });
      throw new UnauthorizedError();
    };
    if (!policy) return reject('unknown_provider');

    if (this.config.get('WEBHOOK_REQUIRE_MTLS')) {
      const verify = req.headers[this.config.get('WEBHOOK_MTLS_VERIFY_HEADER').toLowerCase()];
      if (verify !== 'SUCCESS') reject('mtls_not_verified');
      if (policy.allowedSubjects.length > 0) {
        const subject = String(req.headers[this.config.get('WEBHOOK_MTLS_SUBJECT_HEADER').toLowerCase()] ?? '');
        if (!policy.allowedSubjects.some((s) => subject.includes(s))) reject('mtls_subject_not_allowed');
      }
    }

    if (policy.secret) {
      const params = req.params as Record<string, string | undefined>;
      const candidate = params.token ?? (typeof req.query.token === 'string' ? req.query.token : undefined) ?? req.headers['x-webhook-token'];
      if (typeof candidate !== 'string' || !HashingService.safeEqual(candidate, policy.secret)) reject('invalid_token');
    }

    if (policy.allowedIps) {
      const ip = (req.ip ?? '').replace(/^::ffff:/, '');
      const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      if (!ip || !policy.allowedIps.check(ip, family)) reject('ip_not_allowed');
    }
    return true;
  }
}

function buildBlockList(entries: string[]): BlockList | undefined {
  if (entries.length === 0) return undefined;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(address)) throw new Error(`IP/CIDR inválido na allowlist de webhooks: ${entry}`);
    if (prefix) list.addSubnet(address, Number(prefix), family);
    else list.addAddress(address, family);
  }
  return list;
}
