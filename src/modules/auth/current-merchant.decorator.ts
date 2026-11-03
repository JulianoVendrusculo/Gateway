import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../common/errors';
import { AuthenticatedMerchant } from './authenticated-merchant';

export const CurrentMerchant = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedMerchant => {
  const merchant = ctx.switchToHttp().getRequest<Request>().merchant;
  if (!merchant) throw new UnauthorizedError();
  return merchant;
});
