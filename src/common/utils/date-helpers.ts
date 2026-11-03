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

/** Converte "dd.MM.yyyy" ou "dd/MM/yyyy" (formatos do BB) -> Date UTC. */
export function parseBrDate(value: string): Date | undefined {
  const m = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(value.trim());
  if (!m) return undefined;
  return parseIsoDate(`${m[3]}-${m[2]}-${m[1]}`);
}

/** Formata data civil ("yyyy-MM-dd" em UTC) com o padrão dado, sem conversão de fuso. */
export function formatCivilDate(date: Date, pattern: string): string {
  const iso = date.toISOString();
  return pattern.replace('yyyy', iso.slice(0, 4)).replace('MM', iso.slice(5, 7)).replace('dd', iso.slice(8, 10));
}

export function diffInDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
