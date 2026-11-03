import { isIP } from 'node:net';

/**
 * Anti-SSRF para URLs configuráveis nos convênios: exige HTTPS, sem credenciais embutidas,
 * e host dentro da allowlist (".bb.com.br" casa subdomínios; "api.exemplo.com" casa exato).
 */
export function assertAllowedBankUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`URL inválida: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new Error(`URL deve usar https: ${raw}`);
  if (url.username || url.password) throw new Error('URL não pode conter credenciais');
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((rule) => {
    const r = rule.toLowerCase();
    return r.startsWith('.') ? host.endsWith(r) || host === r.slice(1) : host === r;
  });
  if (!allowed) throw new Error(`host não permitido para integrações bancárias: ${host}`);
  if (isIP(host) && !allowedHosts.includes(host)) throw new Error('IP literal não permitido');
  return url;
}
