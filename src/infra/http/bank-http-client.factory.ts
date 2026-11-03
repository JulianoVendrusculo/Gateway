import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Agent, Dispatcher } from 'undici';
import { AppConfig } from '../../config/app-config';
import { BankHttpClient } from './bank-http-client';
import { MtlsMaterial, toSecureContextOptions } from './mtls-material';

interface CachedAgent {
  agent: Agent;
  lastUsedAt: number;
}

const MAX_CACHED_AGENTS = 500;

/**
 * Mantém um pool de conexões (undici Agent) por convênio+versão de credencial.
 * Reaproveitar o Agent evita refazer o handshake mTLS (caro) a cada chamada.
 * rejectUnauthorized é SEMPRE true — nunca desabilitar verificação do servidor do banco.
 */
@Injectable()
export class BankHttpClientFactory implements OnModuleDestroy {
  private readonly logger = new Logger(BankHttpClientFactory.name);
  private readonly agents = new Map<string, CachedAgent>();
  private dispatcherOverride?: Dispatcher;

  constructor(private readonly config: AppConfig) {}

  create(params: { provider: string; cacheKey: string; mtls?: MtlsMaterial }): BankHttpClient {
    return new BankHttpClient({
      provider: params.provider,
      dispatcher: this.dispatcherOverride ?? this.agentFor(params.cacheKey, params.mtls),
      defaultTimeoutMs: this.config.get('BANK_HTTP_TIMEOUT_MS'),
    });
  }

  /** Apenas para testes (ex.: undici MockAgent). */
  useDispatcherForTesting(dispatcher: Dispatcher | undefined): void {
    this.dispatcherOverride = dispatcher;
  }

  private agentFor(cacheKey: string, mtls?: MtlsMaterial): Agent {
    const cached = this.agents.get(cacheKey);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.agent;
    }
    const agent = new Agent({
      connect: {
        ...(mtls ? toSecureContextOptions(mtls) : { minVersion: 'TLSv1.2' as const }),
        rejectUnauthorized: true,
        timeout: this.config.get('BANK_HTTP_CONNECT_TIMEOUT_MS'),
      },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      connections: 32,
    });
    this.agents.set(cacheKey, { agent, lastUsedAt: Date.now() });
    this.evictIfNeeded();
    return agent;
  }

  private evictIfNeeded(): void {
    if (this.agents.size <= MAX_CACHED_AGENTS) return;
    const oldest = [...this.agents.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    this.agents.delete(oldest[0]);
    oldest[1].agent.close().catch((err: unknown) => this.logger.warn({ msg: 'failed to close agent', err }));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.agents.values()].map((a) => a.agent.close()));
    this.agents.clear();
  }
}
