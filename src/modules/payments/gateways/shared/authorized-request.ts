import { BankAuthenticationError } from '../../../../common/errors';
import { BankHttpClient, BankHttpRequest, BankHttpResponse } from '../../../../infra/http/bank-http-client';
import { isSuccess, toBankError } from './bank-response';

export type TokenSupplier = (forceRefresh: boolean) => Promise<string>;

/**
 * Executa request com Bearer token; em 401 renova o token e tenta UMA vez mais
 * (401 garante que a operação não foi processada, então o retry é seguro).
 */
export async function authorizedRequest(http: BankHttpClient, getToken: TokenSupplier, req: BankHttpRequest): Promise<BankHttpResponse> {
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(attempt > 0);
    const res = await http.request({ ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } });
    if (isSuccess(res)) return res;
    const err = toBankError(http.provider, req.operation, res);
    if (err instanceof BankAuthenticationError && res.status === 401 && attempt === 0) continue;
    throw err;
  }
}
