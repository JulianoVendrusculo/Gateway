import type { Request } from 'express';
import { randomBytes } from 'node:crypto';

export const API_KEY_PREFIX_LENGTH = 12;
const API_KEY_FORMAT = /^pgw_[A-Za-z0-9_-]{43}$/;

/** "pgw_" + 32 bytes aleatórios (base64url). Prefixo de 12 chars é público (lookup). */
export function generateApiKey(): string {
  return `pgw_${randomBytes(32).toString('base64url')}`;
}

export function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  const candidate = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers['x-api-key'];
  return typeof candidate === 'string' && API_KEY_FORMAT.test(candidate) ? candidate : undefined;
}
