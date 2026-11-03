import { parseIsoDate } from '../../../common/utils/date-helpers';
import { barcodeToDigitableLine, buildBarcode } from './boleto-barcode';
import { renderBoletoPdf } from './boleto-pdf.renderer';

describe('renderBoletoPdf', () => {
  it('gera um PDF válido em memória', async () => {
    const barcode = buildBarcode({ bankCode: '001', dueDate: parseIsoDate('2026-11-15'), amountCents: 123456, freeField: '0000003128557000000000117' });
    const pdf = await renderBoletoPdf({
      bankCode: '001',
      bankName: 'Banco do Brasil',
      digitableLine: barcodeToDigitableLine(barcode),
      barcode,
      dueDate: '2026-11-15',
      issueDate: '2026-10-30',
      amountCents: 123456,
      nossoNumero: '31285570000000001',
      documentNumber: '1',
      beneficiary: { name: 'Loja Exemplo Ltda', document: '11222333000181', agencyCode: '1234 / 3128557' },
      payer: { name: 'José da Silva', document: '52998224725', address: 'Rua A, 10 - Centro - Brasília/DF - 70000-000' },
      instructions: ['Não receber após 30 dias do vencimento'],
      pixCopyPaste: '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
  });
});
