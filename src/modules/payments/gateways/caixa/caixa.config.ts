import { ProviderEnvironment } from '@prisma/client';
import { z } from 'zod';
import { pixMerchantFields } from '../shared/convenio-validation';

/**
 * Boleto: webservice SIBAR (SIGCB) da Caixa. Endpoints e versão do leiaute devem ser confirmados
 * com o gerente/kit de homologação da Caixa — todos podem ser sobrescritos em settings.urls.
 * Pix: a Caixa implementa a API Pix padrão BACEN; URLs de OAuth/Pix são entregues no credenciamento,
 * por isso são obrigatórias em settings.urls quando PIX estiver habilitado.
 */
export const CAIXA_SIBAR_DEFAULT_URLS: Record<ProviderEnvironment, { sibarManutencao: string; sibarConsulta: string }> = {
  SANDBOX: {
    sibarManutencao: 'https://des.barramento.caixa.gov.br/sibar/ManutencaoCobrancaBancaria/Boleto/Externo',
    sibarConsulta: 'https://des.barramento.caixa.gov.br/sibar/ConsultaCobrancaBancaria/Boleto',
  },
  PRODUCTION: {
    sibarManutencao: 'https://barramento.caixa.gov.br/sibar/ManutencaoCobrancaBancaria/Boleto/Externo',
    sibarConsulta: 'https://barramento.caixa.gov.br/sibar/ConsultaCobrancaBancaria/Boleto',
  },
};

export const caixaSettingsSchema = z
  .object({
    codigoBeneficiario: z.string().regex(/^\d{6,7}$/),
    /** Agência (UNIDADE) do beneficiário. */
    unidade: z.string().regex(/^\d{4}$/),
    usuarioServico: z.string().regex(/^[A-Z0-9]{1,20}$/).default('SGCBS02P'),
    sistemaOrigem: z.string().regex(/^[A-Z0-9]{1,10}$/).default('SIGCB'),
    versaoLeiaute: z.string().regex(/^\d\.\d$/).default('1.0'),
    pixMerchantName: z.string().min(pixMerchantFields.merchantName.min).max(pixMerchantFields.merchantName.max),
    pixMerchantCity: z.string().min(pixMerchantFields.merchantCity.min).max(pixMerchantFields.merchantCity.max),
    pixOAuthScope: z.string().max(200).optional(),
    urls: z
      .object({
        oauth: z.string().url().optional(),
        pix: z.string().url().optional(),
        sibarManutencao: z.string().url().optional(),
        sibarConsulta: z.string().url().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type CaixaSettings = z.infer<typeof caixaSettingsSchema>;

export const caixaCredentialsSchema = z
  .object({
    clientId: z.string().min(1).max(500).optional(),
    clientSecret: z.string().min(1).max(2000).optional(),
    pixKey: z.string().min(1).max(77).optional(),
  })
  .strict();
