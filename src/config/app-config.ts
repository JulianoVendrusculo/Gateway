import { Env } from './env.schema';

/**
 * Configuração tipada e imutável, validada uma única vez no boot.
 * Injetada via DI (ConfigModule global) — evita process.env espalhado pelo código.
 */
export class AppConfig {
  private readonly env: Readonly<Env>;

  constructor(env: Env) {
    this.env = Object.freeze({ ...env });
  }

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
