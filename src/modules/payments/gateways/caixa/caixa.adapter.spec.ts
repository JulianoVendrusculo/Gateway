import { TransactionStatus } from '@prisma/client';
import { parseIsoDate } from '../../../../common/utils/date-helpers';
import { barcodeToDigitableLine, buildBarcode } from '../../boleto/boleto-barcode';
import { mapConsultaBoleto } from './caixa.adapter';
import { parseSibarResponse } from './caixa-sibar.client';

const NOSSO_NUMERO = '14000000000000001';
const barcode = buildBarcode({ bankCode: '104', dueDate: parseIsoDate('2026-11-15'), amountCents: 15050, freeField: '1234567000100040000000017' });
const line = barcodeToDigitableLine(barcode);

function consulta(retorno: string, titulo = ''): ReturnType<typeof parseSibarResponse> {
  return parseSibarResponse(
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ns:SERVICO_SAIDA xmlns:ns="x">
      <COD_RETORNO>00</COD_RETORNO><DADOS>
        <CONTROLE_NEGOCIAL><COD_RETORNO>0</COD_RETORNO><MENSAGENS><RETORNO>${retorno}</RETORNO></MENSAGENS></CONTROLE_NEGOCIAL>
        <CONSULTA_BOLETO>${titulo}</CONSULTA_BOLETO>
      </DADOS></ns:SERVICO_SAIDA></soapenv:Body></soapenv:Envelope>`,
    'boleto.get',
  );
}

const status = (retorno: string) => mapConsultaBoleto(consulta(retorno), NOSSO_NUMERO);

describe('Caixa: situação do título no CONSULTA_BOLETO', () => {
  it('reconhece a situação com "=" ou ":" como separador', () => {
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = EM ABERTO')).toEqual({ status: TransactionStatus.PENDENTE, providerStatus: 'EM ABERTO' });
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO: LIQUIDADO')).toMatchObject({ status: TransactionStatus.CONFIRMADA, providerStatus: 'LIQUIDADO' });
    expect(status('(0) OPERAÇÃO EFETUADA - SITUAÇÃO DO TÍTULO = LIQUIDADO')).toMatchObject({ status: TransactionStatus.CONFIRMADA });
  });

  it('liquidação em cartório e título pago no dia contam como pagos', () => {
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = LIQUIDADO NO CARTORIO').status).toBe(TransactionStatus.CONFIRMADA);
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = TITULO JA PAGO NO DIA').status).toBe(TransactionStatus.CONFIRMADA);
  });

  it('baixas viram CANCELED', () => {
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = BAIXA POR DEVOLUCAO').status).toBe(TransactionStatus.CANCELADA);
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = BAIXADO').status).toBe(TransactionStatus.CANCELADA);
  });

  it('na dúvida o título continua PENDING (nunca marca pago sem indicação explícita)', () => {
    expect(status('(0) OPERACAO EFETUADA')).toEqual({ status: TransactionStatus.PENDENTE, providerStatus: 'DESCONHECIDA' });
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = ENVIADO AO CARTORIO').status).toBe(TransactionStatus.PENDENTE);
    expect(status('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = NAO LIQUIDADO').status).toBe(TransactionStatus.PENDENTE);
    expect(status('(0) PAGAMENTO EM ANALISE').status).toBe(TransactionStatus.PENDENTE);
  });

  it('recupera os dados do boleto quando a consulta devolve linha digitável e vencimento', () => {
    const titulo = `<TITULO><DATA_VENCIMENTO>2026-11-15</DATA_VENCIMENTO><DATA_EMISSAO>2026-10-30</DATA_EMISSAO></TITULO>
      <LINHA_DIGITAVEL>${line}</LINHA_DIGITAVEL><URL>https://boletoonline.caixa.gov.br/ecobranca/SIGCB/imprimir/1</URL>`;
    const result = mapConsultaBoleto(consulta('(0) OPERACAO EFETUADA - SITUACAO DO TITULO = EM ABERTO', titulo), NOSSO_NUMERO);
    expect(result.providerData?.boleto).toEqual({
      nossoNumero: NOSSO_NUMERO,
      digitableLine: line,
      barcode,
      dueDate: '2026-11-15',
      issueDate: '2026-10-30',
      bankPdfUrl: 'https://boletoonline.caixa.gov.br/ecobranca/SIGCB/imprimir/1',
    });
  });

  it('ignora linha digitável corrompida ou sem vencimento', () => {
    const corrupted = `${line.slice(0, 46)}${(Number(line[46]) + 1) % 10}`;
    const aberto = '(0) OPERACAO EFETUADA - SITUACAO DO TITULO = EM ABERTO';
    expect(mapConsultaBoleto(consulta(aberto, `<TITULO><DATA_VENCIMENTO>2026-11-15</DATA_VENCIMENTO></TITULO><LINHA_DIGITAVEL>${corrupted}</LINHA_DIGITAVEL>`), NOSSO_NUMERO).providerData).toBeUndefined();
    expect(mapConsultaBoleto(consulta(aberto, `<LINHA_DIGITAVEL>${line}</LINHA_DIGITAVEL>`), NOSSO_NUMERO).providerData).toBeUndefined();
  });
});
