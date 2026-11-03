import PDFDocument from 'pdfkit';
import { toBuffer as qrToBuffer } from 'qrcode';
import { centsToDecimalString } from '../../../common/utils/money';
import { formatDigitableLine } from './boleto-barcode';

export interface BoletoPdfData {
  bankCode: string;
  bankName: string;
  digitableLine: string;
  barcode: string;
  dueDate: string;
  issueDate: string;
  amountCents: number;
  nossoNumero: string;
  documentNumber: string;
  beneficiary: { name: string; document: string; agencyCode: string };
  payer: { name: string; document: string; address?: string };
  instructions: string[];
  pixCopyPaste?: string;
}

const BANK_DV: Record<string, string> = { '001': '9', '104': '0' };

// Intercalado 2 de 5 (ITF) — padrão FEBRABAN para o código de barras do boleto.
const ITF = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];

function drawItf(doc: PDFKit.PDFDocument, code: string, x: number, y: number, width: number, height: number): void {
  const units = 4 + (code.length / 2) * 18 + 5; // start + pares (2*(3n+2w), w=3n) + stop
  const n = width / units;
  const w = n * 3;
  let cx = x;
  const bar = (size: number) => {
    doc.rect(cx, y, size, height).fill('#000');
    cx += size;
  };
  const space = (size: number) => (cx += size);
  bar(n), space(n), bar(n), space(n);
  for (let i = 0; i < code.length; i += 2) {
    const bars = ITF[Number(code[i])];
    const spaces = ITF[Number(code[i + 1])];
    for (let j = 0; j < 5; j++) {
      bar(bars[j] === 'w' ? w : n);
      space(spaces[j] === 'w' ? w : n);
    }
  }
  bar(w), space(n), bar(n);
}

const brl = (cents: number) => `R$ ${centsToDecimalString(cents).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const brDate = (iso: string) => iso.split('-').reverse().join('/');
const fmtDoc = (d: string) =>
  d.length === 11
    ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : d.length === 14
      ? d.replace(/(\w{2})(\w{3})(\w{3})(\w{4})(\d{2})/, '$1.$2.$3/$4-$5')
      : d;

/** Gera o PDF (recibo do pagador + ficha de compensação) inteiramente em memória. */
export async function renderBoletoPdf(data: BoletoPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: `Boleto ${data.nossoNumero}`, Producer: 'payment-gateway' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const L = 30;
  const W = 535;
  const bankHeader = `${data.bankCode}-${BANK_DV[data.bankCode] ?? '?'}`;
  const line = formatDigitableLine(data.digitableLine);

  const cell = (x: number, y: number, w: number, h: number, label: string, value: string, align: 'left' | 'right' = 'left') => {
    doc.lineWidth(0.5).rect(x, y, w, h).stroke('#000');
    doc.font('Helvetica').fontSize(6).fillColor('#444').text(label, x + 3, y + 2, { width: w - 6 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text(value, x + 3, y + 11, { width: w - 6, align, lineBreak: false, ellipsis: true });
  };

  const header = (y: number, title: string) => {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text(data.bankName, L, y + 4, { width: 150 });
    doc.moveTo(L + 155, y).lineTo(L + 155, y + 22).stroke();
    doc.fontSize(14).text(bankHeader, L + 160, y + 3, { width: 60, align: 'center' });
    doc.moveTo(L + 222, y).lineTo(L + 222, y + 22).stroke();
    doc.fontSize(title ? 9 : 10.5).text(title || line, L + 228, y + (title ? 7 : 5), { width: W - 228, align: 'right' });
    doc.moveTo(L, y + 22).lineTo(L + W, y + 22).lineWidth(1.5).stroke().lineWidth(0.5);
  };

  // ---------------- Recibo do pagador ----------------
  let y = 30;
  header(y, 'RECIBO DO PAGADOR');
  y += 26;
  cell(L, y, 330, 24, 'Beneficiário', `${data.beneficiary.name} - ${fmtDoc(data.beneficiary.document)}`);
  cell(L + 330, y, 105, 24, 'Agência/Código do Beneficiário', data.beneficiary.agencyCode);
  cell(L + 435, y, 100, 24, 'Vencimento', brDate(data.dueDate), 'right');
  y += 24;
  cell(L, y, 330, 24, 'Pagador', `${data.payer.name} - ${fmtDoc(data.payer.document)}`);
  cell(L + 330, y, 105, 24, 'Nosso Número', data.nossoNumero);
  cell(L + 435, y, 100, 24, '(=) Valor do Documento', brl(data.amountCents), 'right');
  y += 30;
  doc.font('Helvetica').fontSize(8).text(`Linha digitável: ${line}`, L, y);
  if (data.pixCopyPaste) {
    const qr = await qrToBuffer(data.pixCopyPaste, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    doc.image(qr, L + W - 80, y - 4, { width: 80 });
    doc.fontSize(7).text('Pague também com Pix (QR Code ao lado)', L, y + 14);
  }
  y += 100;

  // ---------------- Linha de corte ----------------
  doc.dash(3, { space: 3 }).moveTo(L, y).lineTo(L + W, y).stroke().undash();
  doc.fontSize(6).text('Corte na linha pontilhada', L + W - 90, y + 2);
  y += 16;

  // ---------------- Ficha de compensação ----------------
  header(y, '');
  y += 26;
  const right = 135;
  const left = W - right;
  cell(L, y, left, 24, 'Local de Pagamento', 'PAGÁVEL EM QUALQUER BANCO ATÉ O VENCIMENTO');
  cell(L + left, y, right, 24, 'Vencimento', brDate(data.dueDate), 'right');
  y += 24;
  cell(L, y, left, 24, 'Beneficiário', `${data.beneficiary.name} - ${fmtDoc(data.beneficiary.document)}`);
  cell(L + left, y, right, 24, 'Agência/Código do Beneficiário', data.beneficiary.agencyCode, 'right');
  y += 24;
  const c = left / 5;
  cell(L, y, c, 24, 'Data do Documento', brDate(data.issueDate));
  cell(L + c, y, c, 24, 'Nº do Documento', data.documentNumber);
  cell(L + 2 * c, y, c, 24, 'Espécie Doc.', 'DM');
  cell(L + 3 * c, y, c, 24, 'Aceite', 'N');
  cell(L + 4 * c, y, c, 24, 'Data Processamento', brDate(data.issueDate));
  cell(L + left, y, right, 24, 'Nosso Número', data.nossoNumero, 'right');
  y += 24;
  cell(L, y, c, 24, 'Uso do Banco', '');
  cell(L + c, y, c, 24, 'Carteira', '');
  cell(L + 2 * c, y, c, 24, 'Espécie', 'R$');
  cell(L + 3 * c, y, c, 24, 'Quantidade', '');
  cell(L + 4 * c, y, c, 24, 'Valor', '');
  cell(L + left, y, right, 24, '(=) Valor do Documento', brl(data.amountCents), 'right');
  y += 24;
  doc.rect(L, y, left, 96).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#444').text('Instruções (texto de responsabilidade do beneficiário)', L + 3, y + 2);
  doc.font('Helvetica').fontSize(8).fillColor('#000').text(data.instructions.join('\n') || ' ', L + 3, y + 12, { width: left - 6, height: 80 });
  ['(-) Desconto/Abatimento', '(+) Mora/Multa', '(=) Valor Cobrado', ''].forEach((label, i) => cell(L + left, y + i * 24, right, 24, label, ''));
  y += 96;
  doc.rect(L, y, W, 40).stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#444').text('Pagador', L + 3, y + 2);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text(`${data.payer.name} - ${fmtDoc(data.payer.document)}`, L + 3, y + 11);
  if (data.payer.address) doc.font('Helvetica').fontSize(8).text(data.payer.address, L + 3, y + 23, { width: W - 6 });
  y += 48;
  drawItf(doc, data.barcode, L, y, 292, 40); // 103mm x ~13mm (FEBRABAN)
  doc.font('Helvetica').fontSize(6).text('Autenticação mecânica - Ficha de Compensação', L + W - 160, y + 2, { width: 160, align: 'right' });

  doc.end();
  return done;
}
