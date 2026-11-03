import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../common/errors';
import { AppConfig } from '../../config/app-config';
import { HashingService } from '../../infra/crypto/hashing.service';

/**
 * Proteção das rotas /v1/admin. Em produção, recomenda-se mover o back-office para
 * rede privada/VPN + SSO com RBAC; este token é a barreira mínima.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.headers['x-admin-token'];
    if (typeof token !== 'string' || !HashingService.safeEqual(token, this.config.get('ADMIN_API_TOKEN'))) {
      this.logger.warn({ msg: 'admin auth rejected', ip: req.ip });
      throw new UnauthorizedError();
    }
    return true;
  }
}
