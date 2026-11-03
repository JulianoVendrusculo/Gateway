import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface HashingKeys {
  blindIndexKey: Buffer;
  apiKeyPepper: Buffer;
}

@Injectable()
export class HashingService {
  constructor(private readonly keys: HashingKeys) {}

  /**
   * Blind index: HMAC determinístico para busca/unicidade de dados cifrados
   * (ex.: CPF do pagador) sem guardar o valor em claro. `domain` separa contextos.
   */
  blindIndex(domain: string, value: string): string {
    return createHmac('sha256', this.keys.blindIndexKey).update(`${domain}\u0000${value}`).digest('hex');
  }

  hashApiKey(apiKey: string): string {
    return createHmac('sha256', this.keys.apiKeyPepper).update(apiKey).digest('hex');
  }

  sha256Hex(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /** Comparação em tempo constante, inclusive para tamanhos diferentes. */
  static safeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a, 'utf8').digest();
    const hb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(ha, hb) && a.length === b.length;
  }
}
