import { PaymentMethod, Transaction, TransactionStatus as S } from '@prisma/client';
import { AppConfig } from '../../../config/app-config';
import { ChargeStatusResult } from '../domain/payment-gateway.port';
import { AttemptLifecycleService } from './attempt-lifecycle.service';

const NOW = new Date('2026-11-15T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const windows = { VERIFICATION_WINDOW_PIX_SECONDS: 0, VERIFICATION_WINDOW_BOLETO_SECONDS: 3 * 86_400, VERIFICATION_WINDOW_CARD_SECONDS: 1800 };
const config = { get: (key: keyof typeof windows) => windows[key] } as unknown as AppConfig;
// `decide` é pura: só depende da configuração das janelas.
const service = new AttemptLifecycleService(null as never, null as never, null as never, null as never, null as never, config);

const attempt = (patch: Partial<Transaction>): Transaction =>
  ({ status: S.PENDENTE, method: PaymentMethod.CREDIT_CARD, expiresAt: minutes(10), verificationUntil: null, ...patch }) as Transaction;
const provider = (status: ChargeStatusResult['status']): ChargeStatusResult => ({ status, providerStatus: status });

describe('AttemptLifecycleService.decide', () => {
  it('pagamento informado pelo banco é sempre registrado, qualquer que seja o status da tentativa', () => {
    for (const status of [S.PENDENTE, S.PROCESSANDO, S.EM_VERIFICACAO, S.CANCELADA, S.EXPIRADA, S.FALHOU, S.CONFIRMADA]) {
      expect(service.decide(attempt({ status }), provider(S.CONFIRMADA), NOW)).toBe('SETTLE');
    }
  });

  it('tentativa válida e aberta no banco: nada muda', () => {
    expect(service.decide(attempt({}), provider(S.PENDENTE), NOW)).toBe('NONE');
  });

  it('cancelada no banco: a tentativa ativa é cancelada; a que já estava encerrada não muda', () => {
    expect(service.decide(attempt({}), provider(S.CANCELADA), NOW)).toBe('CANCEL');
    expect(service.decide(attempt({ status: S.EM_VERIFICACAO, verificationUntil: minutes(5) }), provider(S.CANCELADA), NOW)).toBe('CANCEL');
    expect(service.decide(attempt({ status: S.EXPIRADA }), provider(S.CANCELADA), NOW)).toBe('NONE');
  });

  it('criação de resultado incerto que o banco conhece passa a PENDENTE', () => {
    expect(service.decide(attempt({ status: S.PROCESSANDO, expiresAt: null }), provider(S.PENDENTE), NOW)).toBe('REGISTER');
  });

  it('link de cartão vencido NÃO é liberado direto: entra em verificação pela janela de tolerância', () => {
    const expired = attempt({ expiresAt: minutes(-1) });
    expect(service.decide(expired, provider(S.EXPIRADA), NOW)).toBe('VERIFY');
    expect(service.decide(expired, provider(S.PENDENTE), NOW)).toBe('VERIFY');
    expect(service.verificationDeadline(expired, NOW)).toEqual(minutes(29));
    // O banco diz que venceu antes do nosso relógio: também verifica.
    expect(service.decide(attempt({ expiresAt: minutes(2) }), provider(S.EXPIRADA), NOW)).toBe('VERIFY');
  });

  it('em verificação: espera a janela e só depois expira', () => {
    expect(service.decide(attempt({ status: S.EM_VERIFICACAO, verificationUntil: minutes(1) }), provider(S.EXPIRADA), NOW)).toBe('NONE');
    expect(service.decide(attempt({ status: S.EM_VERIFICACAO, verificationUntil: minutes(-1) }), provider(S.EXPIRADA), NOW)).toBe('EXPIRE');
    expect(service.decide(attempt({ status: S.EM_VERIFICACAO, verificationUntil: null }), provider(S.EXPIRADA), NOW)).toBe('EXPIRE');
  });

  it('a janela é por método: Pix com janela zero expira na hora; boleto espera a compensação', () => {
    const vencida = { expiresAt: minutes(-1) };
    expect(service.decide(attempt({ ...vencida, method: PaymentMethod.PIX }), provider(S.EXPIRADA), NOW)).toBe('EXPIRE');
    expect(service.decide(attempt({ ...vencida, method: PaymentMethod.BOLETO }), provider(S.PENDENTE), NOW)).toBe('VERIFY');
    expect(service.verificationDeadline(attempt({ ...vencida, method: PaymentMethod.BOLETO }), NOW)).toEqual(new Date(minutes(-1).getTime() + 3 * 86_400_000));
  });

  it('se o job atrasou além da janela, a tentativa vencida expira sem passar por verificação', () => {
    expect(service.decide(attempt({ expiresAt: minutes(-31) }), provider(S.EXPIRADA), NOW)).toBe('EXPIRE');
  });

  it('tentativa encerrada sem pagamento no banco não muda', () => {
    for (const status of [S.CANCELADA, S.EXPIRADA, S.FALHOU, S.CONFIRMADA, S.PAGO_DUPLICADO]) {
      expect(service.decide(attempt({ status }), provider(S.PENDENTE), NOW)).toBe('NONE');
      expect(service.decide(attempt({ status }), provider(S.EXPIRADA), NOW)).toBe('NONE');
    }
  });
});
