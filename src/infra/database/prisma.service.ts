import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfig } from '../../config/app-config';

/**
 * Prisma usa sempre queries parametrizadas (proteção nativa contra SQL injection).
 * Regra do projeto: proibido $queryRawUnsafe/$executeRawUnsafe; use apenas $queryRaw com tagged template.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL') } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    (this as PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>).$on('warn', (e) =>
      this.logger.warn({ msg: 'prisma warning', target: e.target, detail: e.message }),
    );
    (this as PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>).$on('error', (e) =>
      this.logger.error({ msg: 'prisma error', target: e.target, detail: e.message }),
    );
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!field) return true;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes(field) : typeof target === 'string' && target.includes(field);
}
