import { createHash } from 'node:crypto';
import { BankRejectedError, BankUnavailableError } from '../../../../common/errors';
import { parseIsoDate } from '../../../../common/utils/date-helpers';
import { caixaNossoNumero } from './caixa.adapter';
import { buildIncluiBoletoXml, parseSibarResponse, sibarAuthHash } from './caixa-sibar.client';

const header = { versao: '1.0', autenticacao: 'HASH', usuarioServico: 'SGCBS02P', operacao: 'INCLUI_BOLETO' as const, sistemaOrigem: 'SIGCB', unidade: '1234', now: new Date('2026-10-30T15:00:00Z') };

describe('Caixa SIBAR', () => {
  it('calcula o hash de autenticação sobre os campos posicionais', () => {
    const expectedRaw = '1234567' + '14000000000000001' + '15112026' + '000000000015050' + '11222333000181';
    expect(
      sibarAuthHash({ codigoBeneficiario: '1234567', nossoNumero: '14000000000000001', dueDate: parseIsoDate('2026-11-15'), amountCents: 15050, beneficiaryDocument: '11222333000181' }),
    ).toBe(createHash('sha256').update(expectedRaw).digest('base64'));
  });

  it('monta nosso número SIGCB (14 + 15 dígitos)', () => {
    expect(caixaNossoNumero(42n)).toBe('14000000000000042');
  });

  it('escapa dados do pagador no XML (sem XML injection) e usa horário de Brasília', () => {
    const xml = buildIncluiBoletoXml(header, {
      codigoBeneficiario: '1234567',
      nossoNumero: '14000000000000001',
      numeroDocumento: '1',
      dueDate: parseIsoDate('2026-11-15'),
      issueDate: parseIsoDate('2026-10-30'),
      amountCents: 15050,
      messages: [],
      payer: { documentType: 'CPF', document: '52998224725', name: 'A</NOME><X>&', street: 'R', neighborhood: 'B', city: 'C', state: 'DF', zipCode: '70000000' },
    });
    expect(xml).toContain('<NOME>A&lt;/NOME&gt;&lt;X&gt;&amp;</NOME>');
    expect(xml).toContain('<DATA_HORA>20261030120000</DATA_HORA>');
    expect(xml).toContain('<VALOR>150.50</VALOR>');
  });

  it('interpreta sucesso e preserva zeros à esquerda', () => {
    const res = parseSibarResponse(
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ns:SERVICO_SAIDA xmlns:ns="x">
        <COD_RETORNO>0</COD_RETORNO><DADOS><CONTROLE_NEGOCIAL><COD_RETORNO>0</COD_RETORNO><MENSAGENS><RETORNO>(0) OPERACAO EFETUADA</RETORNO></MENSAGENS></CONTROLE_NEGOCIAL>
        <INCLUI_BOLETO><CODIGO_BARRAS>10491000000000000000000000000000000000000000</CODIGO_BARRAS><NOSSO_NUMERO>14000000000000001</NOSSO_NUMERO></INCLUI_BOLETO></DADOS>
      </ns:SERVICO_SAIDA></soapenv:Body></soapenv:Envelope>`,
      'boleto.create',
    );
    expect((res.dados.INCLUI_BOLETO as Record<string, string>).NOSSO_NUMERO).toBe('14000000000000001');
    expect(res.messages).toEqual(['(0) OPERACAO EFETUADA']);
  });

  it('COD_RETORNO diferente de zero vira BankRejectedError; Fault Server vira resultado incerto', () => {
    const rejected = `<Envelope><Body><SERVICO_SAIDA><DADOS><CONTROLE_NEGOCIAL><COD_RETORNO>1</COD_RETORNO><MENSAGENS><RETORNO>(54) NOSSO NUMERO JA CADASTRADO</RETORNO></MENSAGENS></CONTROLE_NEGOCIAL></DADOS></SERVICO_SAIDA></Body></Envelope>`;
    expect(() => parseSibarResponse(rejected, 'boleto.create')).toThrow(BankRejectedError);
    const fault = `<Envelope><Body><Fault><faultcode>soapenv:Server</faultcode><faultstring>erro</faultstring></Fault></Body></Envelope>`;
    expect(() => parseSibarResponse(fault, 'boleto.create')).toThrow(BankUnavailableError);
  });
});
