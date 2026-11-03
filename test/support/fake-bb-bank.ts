import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Server, createServer } from 'node:https';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { barcodeToDigitableLine, buildBarcode } from '../../src/modules/payments/boleto/boleto-barcode';
import { parseBrDate } from '../../src/common/utils/date-helpers';

export const CERT_DIR = join(__dirname, '..', '.certs');
export const certFile = (name: string) => readFileSync(join(CERT_DIR, name), 'utf8');
export const certBase64 = (name: string) => readFileSync(join(CERT_DIR, name)).toString('base64');

export const BB_CLIENT_ID = 'e2e-client-id';
export const BB_CLIENT_SECRET = 'e2e-client-secret';
export const BB_DEV_APP_KEY = 'e2e-dev-app-key';
const ACCESS_TOKEN = 'fake-access-token';

interface Cob {
  txid: string;
  status: string;
  criacao: string;
  expiracao: number;
  valor: string;
  location: string;
  paidAt?: string;
}

interface Boleto {
  numero: string;
  estado: number;
  valor: number;
  linha: string;
  barcode: string;
  vencimento: string;
  emissao: string;
}

/**
 * Simulador mínimo das APIs do BB (OAuth, Pix v2, Cobranças v2) sobre HTTPS com mTLS obrigatório:
 * requestCert + rejectUnauthorized — conexões sem certificado cliente assinado pela CA são recusadas.
 */
export class FakeBbBank {
  private server?: Server;
  readonly cobs = new Map<string, Cob>();
  readonly boletos = new Map<string, Boleto>();
  readonly clientSubjects: string[] = [];
  readonly requests: Array<{ method: string; path: string; body: unknown }> = [];

  get baseUrl(): string {
    return `https://localhost:${(this.server!.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.server = createServer(
      {
        key: certFile('server.key'),
        cert: certFile('server.crt'),
        ca: [certFile('ca.crt')],
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      (req, res) => void this.handle(req, res),
    );
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  payPix(txid: string): void {
    const cob = this.cobs.get(txid)!;
    cob.status = 'CONCLUIDA';
    cob.paidAt = new Date().toISOString();
  }

  liquidateBoleto(numero: string): void {
    this.boletos.get(numero)!.estado = 6;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cert = (req.socket as TLSSocket).getPeerCertificate();
    this.clientSubjects.push(String(cert?.subject?.CN ?? ''));
    const url = new URL(req.url ?? '/', 'https://localhost');
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw;
    this.requests.push({ method: req.method ?? '', path: url.pathname, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const expected = `Basic ${Buffer.from(`${BB_CLIENT_ID}:${BB_CLIENT_SECRET}`).toString('base64')}`;
      if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' });
      return send(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 600 });
    }
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return send(401, { error: 'invalid_token' });
    if (url.searchParams.get('gw-dev-app-key') !== BB_DEV_APP_KEY) return send(403, { erros: [{ codigo: '403', mensagem: 'app key inválida' }] });

    const cobMatch = /^\/pix\/v2\/cob\/([A-Za-z0-9]{26,35})$/.exec(url.pathname);
    if (cobMatch && req.method === 'PUT') {
      const b = body as { calendario: { expiracao: number }; valor: { original: string } };
      if (b.valor.original === '6.66') {
        return send(400, { type: 'https://pix.bcb.gov.br/api/v2/error/CobOperacaoInvalida', title: 'Cobrança inválida', status: 400, detail: 'A requisição possui campos inválidos', violacoes: [{ razao: 'chave não pertence ao recebedor', propriedade: 'cob.chave' }] });
      }
      const cob: Cob = { txid: cobMatch[1], status: 'ATIVA', criacao: new Date().toISOString(), expiracao: b.calendario.expiracao, valor: b.valor.original, location: `pix.example.com/qr/v2/${randomUUID()}` };
      this.cobs.set(cob.txid, cob);
      return send(201, this.cobJson(cob));
    }
    if (cobMatch && req.method === 'GET') {
      const cob = this.cobs.get(cobMatch[1]);
      return cob ? send(200, this.cobJson(cob)) : send(404, { title: 'Cobrança não encontrada', status: 404 });
    }

    if (req.method === 'POST' && url.pathname === '/cobrancas/v2/boletos') {
      const b = body as { numeroTituloCliente: string; valorOriginal: number; dataVencimento: string; dataEmissao: string; numeroCarteira: number };
      const nossoNumero = b.numeroTituloCliente.slice(3);
      const barcode = buildBarcode({
        bankCode: '001',
        dueDate: parseBrDate(b.dataVencimento)!,
        amountCents: Math.round(b.valorOriginal * 100),
        freeField: `000000${nossoNumero}${String(b.numeroCarteira).padStart(2, '0')}`,
      });
      const boleto: Boleto = { numero: b.numeroTituloCliente, estado: 1, valor: b.valorOriginal, barcode, linha: barcodeToDigitableLine(barcode), vencimento: b.dataVencimento, emissao: b.dataEmissao };
      this.boletos.set(boleto.numero, boleto);
      // 7.77 simula "registrou, mas a resposta se perdeu" (resultado incerto).
      if (b.valorOriginal === 7.77) return send(503, { erros: [{ codigo: '503', mensagem: 'Serviço indisponível' }] });
      return send(201, { numero: boleto.numero, linhaDigitavel: boleto.linha, codigoBarraNumerico: boleto.barcode });
    }
    const boletoMatch = /^\/cobrancas\/v2\/boletos\/(\d{20})$/.exec(url.pathname);
    if (boletoMatch && req.method === 'GET') {
      const boleto = this.boletos.get(boletoMatch[1]);
      if (!boleto) return send(404, { erros: [{ codigo: '404', mensagem: 'Título não encontrado' }] });
      return send(200, {
        codigoEstadoTituloCobranca: boleto.estado,
        codigoLinhaDigitavel: boleto.linha,
        codigoBarraNumerico: boleto.barcode,
        dataVencimentoTituloCobranca: boleto.vencimento,
        dataEmissaoTituloCobranca: boleto.emissao,
        ...(boleto.estado === 6 ? { valorPagoSacado: boleto.valor, dataRecebimentoTitulo: boleto.vencimento } : {}),
      });
    }
    return send(404, { error: 'not_found' });
  }

  private cobJson(cob: Cob) {
    return {
      txid: cob.txid,
      revisao: 0,
      status: cob.status,
      calendario: { criacao: cob.criacao, expiracao: cob.expiracao },
      location: cob.location,
      valor: { original: cob.valor },
      ...(cob.paidAt ? { pix: [{ endToEndId: `E00000000${cob.txid.slice(0, 20)}`, txid: cob.txid, valor: cob.valor, horario: cob.paidAt }] } : {}),
    };
  }
}
