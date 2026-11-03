import { parseIsoDate } from '../../../common/utils/date-helpers';
import {
  barcodeToDigitableLine,
  buildBarcode,
  digitableLineToBarcode,
  dueDateFactor,
  formatDigitableLine,
  isValidBarcode,
  isValidDigitableLine,
  mod10,
} from './boleto-barcode';

describe('boleto barcode (FEBRABAN)', () => {
  it('calcula o fator de vencimento com o reinício de 22/02/2025', () => {
    expect(dueDateFactor(parseIsoDate('2000-07-03'))).toBe('1000');
    expect(dueDateFactor(parseIsoDate('2025-02-21'))).toBe('9999');
    expect(dueDateFactor(parseIsoDate('2025-02-22'))).toBe('1000');
    expect(dueDateFactor(parseIsoDate('2026-11-15'))).toBe('1631');
  });

  it('mód. 10 confere com vetor conhecido', () => {
    expect(mod10('001900000')).toBe(9);
  });

  it('monta código de barras válido e converte ida/volta com a linha digitável', () => {
    const barcode = buildBarcode({
      bankCode: '001',
      dueDate: parseIsoDate('2026-11-15'),
      amountCents: 15050,
      freeField: '0000003128557000000001517',
    });
    expect(barcode).toHaveLength(44);
    expect(isValidBarcode(barcode)).toBe(true);
    expect(barcode.slice(9, 19)).toBe('0000015050');

    const line = barcodeToDigitableLine(barcode);
    expect(line).toHaveLength(47);
    expect(isValidDigitableLine(line)).toBe(true);
    expect(digitableLineToBarcode(formatDigitableLine(line))).toBe(barcode);
    expect(formatDigitableLine(line)).toMatch(/^\d{5}\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{14}$/);
  });

  it('rejeita linha digitável com dígito alterado', () => {
    const line = barcodeToDigitableLine(
      buildBarcode({ bankCode: '104', dueDate: parseIsoDate('2026-12-01'), amountCents: 999, freeField: '1234567890123456789012345' }),
    );
    const tampered = line.slice(0, 40) + ((Number(line[40]) + 1) % 10) + line.slice(41);
    expect(isValidDigitableLine(tampered)).toBe(false);
  });
});
