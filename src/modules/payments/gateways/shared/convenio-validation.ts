import { ZodTypeAny, z } from 'zod';
import { ConvenioValidationError } from '../../../../common/errors';

/** Valida com zod e converte em erro de domínio — lista caminhos/motivos, nunca valores (podem ser segredos). */
export function parseConvenioPart<S extends ZodTypeAny>(schema: S, value: unknown, part: 'settings' | 'credentials'): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ConvenioValidationError(`Configuração inválida em "${part}"`, {
      details: { issues: result.error.issues.map((i) => `${part}.${i.path.join('.')}: ${i.message}`) },
    });
  }
  return result.data as z.output<S>;
}

export function assertNoProblems(problems: string[]): void {
  if (problems.length > 0) {
    throw new ConvenioValidationError('Convênio incompatível com os métodos/ambiente informados', { details: { issues: problems } });
  }
}

export const pixMerchantFields = {
  /** Nome do recebedor no BR Code (máx. 25) e cidade (máx. 15) — usados se o PSP não devolver o copia-e-cola. */
  merchantName: { min: 1, max: 25 },
  merchantCity: { min: 1, max: 15 },
} as const;
