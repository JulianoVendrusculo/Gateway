import { buildDynamicPixBrCode, buildStaticPixBrCode, crc16, isValidBrCode } from './pix-brcode';

describe('Pix BR Code', () => {
  it('reproduz o exemplo oficial do Manual de Padrões do BACEN (CRC 1D3D)', () => {
    const code = buildStaticPixBrCode({
      key: '123e4567-e12b-12d1-a456-426655440000',
      merchantName: 'Fulano de Tal',
      merchantCity: 'BRASILIA',
    });
    expect(code).toBe(
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    );
    expect(isValidBrCode(code)).toBe(true);
  });

  it('gera BR Code dinâmico válido a partir do location, sem acentos', () => {
    const code = buildDynamicPixBrCode({
      location: 'https://qrcodepix.bb.com.br/pix/v2/9d36b84f-c70b-478f-b95c-12729b90ca25',
      merchantName: 'Padaria São João Ltda',
      merchantCity: 'São Paulo',
    });
    expect(code).toContain('010212');
    expect(code).toContain('qrcodepix.bb.com.br/pix/v2/9d36b84f');
    expect(code).not.toContain('https://');
    expect(code).toContain('Padaria Sao Joao Ltda');
    expect(isValidBrCode(code)).toBe(true);
  });

  it('detecta copia-e-cola corrompido', () => {
    const code = buildStaticPixBrCode({ key: 'a@b.com', merchantName: 'X', merchantCity: 'Y', amountCents: 1050 });
    expect(code).toContain('540510.50');
    expect(isValidBrCode(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(isValidBrCode('lixo')).toBe(false);
  });

  it('CRC16-CCITT-FALSE confere com vetor conhecido', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
});
