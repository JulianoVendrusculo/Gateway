export const BR_TIMEZONE = 'America/Sao_Paulo';

interface DateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function partsInBrazil(date: Date): DateParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out as unknown as DateParts;
}

/** Formata no fuso de Brasília. Padrões: yyyy, MM, dd, HH, mm, ss. */
export function formatBr(date: Date, pattern: string): string {
  const p = partsInBrazil(date);
  return pattern
    .replace('yyyy', p.year)
    .replace('MM', p.month)
    .replace('dd', p.day)
    .replace('HH', p.hour)
    .replace('mm', p.minute)
    .replace('ss', p.second);
}

/** Data civil de hoje em Brasília, "yyyy-MM-dd". */
export function todayBr(now: Date = new Date()): string {
  return formatBr(now, 'yyyy-MM-dd');
}

/** "yyyy-MM-dd" -> Date às 00:00 UTC (data civil, sem hora). */
export function parseIsoDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new RangeError(`data inválida: ${value}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== value) throw new RangeError(`data inválida: ${value}`);
  return d;
}

/**
 * Converte "dd.MM.yyyy" ou "dd/MM/yyyy" (formatos do BB, com ou sem hora) -> Date UTC.
 * Nunca lança: o banco usa marcadores como "00.00.0000" em campos sem valor, e isso
 * não pode derrubar a consulta de um título pago.
 */
export function parseBrDate(value: string): Date | undefined {
  const m = /^(\d{2})[./](\d{2})[./](\d{4})(?:\s|$)/.exec(value.trim());
  if (!m) return undefined;
  try {
    return parseIsoDate(`${m[3]}-${m[2]}-${m[1]}`);
  } catch {
    return undefined;
  }
}

/** Formata data civil ("yyyy-MM-dd" em UTC) com o padrão dado, sem conversão de fuso. */
export function formatCivilDate(date: Date, pattern: string): string {
  const iso = date.toISOString();
  return pattern.replace('yyyy', iso.slice(0, 4)).replace('MM', iso.slice(5, 7)).replace('dd', iso.slice(8, 10));
}

export function diffInDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Último instante de uma data civil no horário de Brasília (23:59:59.999, UTC-3).
 * O Brasil não adota horário de verão desde 2019, por isso o deslocamento é fixo.
 */
export function endOfCivilDayBr(civilDate: Date): Date {
  return new Date(civilDate.getTime() + 86_400_000 + 3 * 3_600_000 - 1);
}
