import { ProviderEnvironment } from '@prisma/client';
import { z } from 'zod';
import { pixMerchantFields } from '../shared/convenio-validation';

/**
 * Endpoints padrão do BB. Confirme no Portal Developers BB (developers.bb.com.br) antes de produção —
 * qualquer um pode ser sobrescrito por convênio em settings.urls (sujeito à allowlist anti-SSRF).
 * Produção da API Pix exige mTLS com certificado ICP-Brasil cadastrado no portal.
 */
export const BB_DEFAULT_URLS: Record<ProviderEnvironment, { oauth: string; pix: string; cobranca: string }> = {
  SANDBOX: {
    oauth: 'https://oauth.hm.bb.com.br/oauth/token',
    pix: 'https://api.hm.bb.com.br/pix/v2',
    cobranca: 'https://api.hm.bb.com.br/cobrancas/v2',
  },
  PRODUCTION: {
    oauth: 'https://oauth.bb.com.br/oauth/token',
    pix: 'https://api-pix.bb.com.br/pix/v2',
    cobranca: 'https://api.bb.com.br/cobrancas/v2',
  },
};

export const BB_SCOPES = {
  pix: 'cob.write cob.read pix.read',
  cobranca: 'cobrancas.boletos-info cobrancas.boletos-requisicao',
} as const;

export const bbSettingsSchema = z
  .object({
    numeroConvenio: z.coerce.number().int().min(1).max(9_999_999),
    numeroCarteira: z.coerce.number().int().min(1).max(99),
    numeroVariacaoCarteira: z.coerce.number().int().min(1).max(999),
    codigoModalidade: z.coerce.number().int().min(1).max(9).default(1),
    agencia: z.string().regex(/^\d{1,5}$/).optional(),
    conta: z.string().regex(/^[\dXx-]{1,15}$/).optional(),
    pixMerchantName: z.string().min(pixMerchantFields.merchantName.min).max(pixMerchantFields.merchantName.max),
    pixMerchantCity: z.string().min(pixMerchantFields.merchantCity.min).max(pixMerchantFields.merchantCity.max),
    /** Boleto híbrido: registra QR Code Pix junto do boleto (indicadorPix). */
    boletoComPix: z.boolean().default(false),
    urls: z
      .object({ oauth: z.string().url().optional(), pix: z.string().url().optional(), cobranca: z.string().url().optional() })
      .strict()
      .default({}),
  })
  .strict();

export type BbSettings = z.infer<typeof bbSettingsSchema>;

export const bbCredentialsSchema = z
  .object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    developerAppKey: z.string().min(1).max(200),
    pixKey: z.string().min(1).max(77).optional(),
  })
  .strict();

export function resolveBbUrls(env: ProviderEnvironment, settings: BbSettings): { oauth: string; pix: string; cobranca: string } {
  return { ...BB_DEFAULT_URLS[env], ...settings.urls };
}
