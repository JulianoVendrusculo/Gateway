# Payment Gateway (white-label)

Gateway de pagamentos multi-lojista para **Pix**, **Boleto** e **Cartão de Crédito**, com roteamento
dinâmico para **Banco do Brasil** e **Caixa Econômica Federal** e adquirente de cartão plugável.

Stack: Node.js 22 · TypeScript 5.9 · NestJS 11 · PostgreSQL 16 · Prisma 6 · undici (mTLS) · pino.

---

## Arquitetura

```
             ┌──────────────────────── API REST (NestJS) ────────────────────────┐
 Lojista ──► │ ApiKeyGuard → ValidationPipe → PaymentsController                 │
             │                                   │ IdempotencyService            │
             │                                   ▼                               │
             │                       ProcessPaymentUseCase                       │
             │   ConvenioResolver ─► GatewayContextFactory ─► PaymentGatewayRegistry
             │   (qual convênio?)    (decifra credenciais,     (Strategy: qual adapter?)
             │                        cliente HTTP mTLS)                │        │
             └──────────────────────────────────────────────────────────┼────────┘
                                                                        ▼
                           IPaymentGateway (Port)  ◄── contrato único
             ┌──────────────────────┬──────────────────────┬──────────────────────┐
             │ BancoDoBrasilAdapter │ CaixaAdapter         │ MockAcquirerAdapter  │
             │ Pix: API BACEN v2    │ Pix: API BACEN v2    │ Cartão (tokenização) │
             │ Boleto: Cobranças v2 │ Boleto: SIBAR (SOAP) │                      │
             └──────────────────────┴──────────────────────┴──────────────────────┘
 Banco ─► POST /v1/webhooks/{bb|caixa} ─► WebhookAuthGuard ─► ProcessWebhookUseCase
                                                   └─► SyncPaymentStatusUseCase (reconsulta o banco)
 ReconciliationJob (intervalo) ───────────────────────► SyncPaymentStatusUseCase
```

**Ports & Adapters + Strategy.** O núcleo só conhece `IPaymentGateway`
(`src/modules/payments/domain/payment-gateway.port.ts`). Em runtime, o convênio da transação define o
provedor e o `PaymentGatewayRegistry` entrega o adapter. Para adicionar um banco, implemente a
interface e registre o adapter em `gateways.module.ts`. Nenhum outro arquivo muda.

### Estrutura

```
prisma/                      schema + migrations (com CHECK constraints)
src/
  config/                    validação do .env com zod (o boot falha se algo estiver errado)
  common/                    erros tipados, filtro global, logs, sanitização, CPF/CNPJ, dinheiro, datas
  infra/
    crypto/                  AES-256-GCM com chaveiro rotacionável + HMAC (blind index / API keys)
    http/                    cliente bancário mTLS (undici), inspeção de certificado, guarda anti-SSRF
    database/                Prisma
  modules/
    auth/                    API key do lojista (HMAC + comparação em tempo constante), token admin
    merchants/ convenios/    administração (convênios com credenciais cifradas)
    customers/               pagadores (PII cifrada + blind index)
    idempotency/             Idempotency-Key
    payments/
      domain/                port IPaymentGateway + máquina de estados
      gateways/              adapters BB, Caixa, adquirente mock + clientes OAuth2/Pix BACEN
      application/           casos de uso (processar, consultar, sincronizar, tokenizar)
      boleto/ pix/           código de barras FEBRABAN, PDF, BR Code EMV/CRC16, QR Code
      reconciliation/        job de reconciliação ativa
    webhooks/                recepção autenticada de notificações bancárias
test/                        e2e com "banco falso" HTTPS exigindo mTLS real
```

---

## Como rodar

```bash
npm ci
cp .env.example .env
npm run keys:generate           # cole os valores gerados no .env
docker compose up -d postgres   # ou um Postgres 16 local
npx prisma migrate deploy
npm run start:dev               # http://localhost:3000/health
```

Testes:

```bash
npm test                        # unitários (51)
npm run test:e2e                # e2e (21): Postgres real + banco falso com mTLS
```

O e2e usa o banco `payment_gateway_test`, que pode ser alterado via `TEST_DATABASE_URL`. Ele gera uma
PKI de teste com `openssl` em `test/.certs` e limpa as tabelas desse banco a cada execução.

---

## Uso da API

Todos os valores são **em centavos** (inteiros). Datas civis seguem `YYYY-MM-DD`, no fuso de Brasília.

### 1. Cadastrar lojista e convênio (admin)

```bash
curl -X POST localhost:3000/v1/admin/merchants -H "x-admin-token: $ADMIN_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Loja Exemplo Ltda","document":"11.222.333/0001-81","email":"ops@loja.com"}'
# => { merchant: {...}, apiKey: "pgw_..." }   (a API key aparece só nesta resposta)

curl -X POST localhost:3000/v1/admin/merchants/$MERCHANT_ID/convenios -H "x-admin-token: $ADMIN_API_TOKEN" \
  -H 'content-type: application/json' -d '{
    "provider": "BANCO_DO_BRASIL",
    "environment": "SANDBOX",
    "label": "BB principal",
    "supportedMethods": ["PIX", "BOLETO"],
    "priority": 10,
    "settings": { "numeroConvenio": 3128557, "numeroCarteira": 17, "numeroVariacaoCarteira": 35,
                  "agencia": "1234", "pixMerchantName": "Loja Exemplo", "pixMerchantCity": "Brasilia" },
    "credentials": { "clientId": "...", "clientSecret": "...", "developerAppKey": "...", "pixKey": "pix@loja.com.br" },
    "certificate": { "format": "PFX", "pfxBase64": "<base64 do .pfx A1>", "passphrase": "..." }
  }'
```

Na criação do convênio o gateway faz o seguinte:
- valida `settings` e `credentials` com o schema do provedor (ex.: em produção, BB exige certificado);
- confere a senha do certificado, se a chave bate com o certificado e se está dentro da validade, e guarda subject, fingerprint e data de expiração;
- confere URLs sobrescritas contra `BANK_URL_ALLOWED_HOSTS` (anti-SSRF);
- cifra credenciais e certificado com AES-256-GCM. A resposta nunca devolve segredos, só máscaras.

Outras rotas admin: `GET /v1/admin/merchants/:id/convenios`, `PATCH /v1/admin/convenios/:id`,
`PUT /v1/admin/convenios/:id/credentials` (rotação) e `POST /v1/admin/merchants/:id/api-key/rotate`.

Exemplo de convênio **Caixa**: `settings` = `{ codigoBeneficiario, unidade, pixMerchantName, pixMerchantCity, urls: { oauth, pix } }`.
As URLs de Pix da Caixa são entregues no credenciamento.

### 2. Criar cobrança

```bash
curl -X POST localhost:3000/v1/payments -H "authorization: Bearer $API_KEY" \
  -H 'idempotency-key: pedido-1001-v1' -H 'content-type: application/json' -d '{
    "method": "PIX",
    "amount": 15050,
    "description": "Pedido #1001",
    "externalReference": "pedido-1001",
    "customer": { "name": "José da Silva", "document": "529.982.247-25", "email": "jose@ex.com" },
    "pix": { "expiresInSeconds": 3600 }
  }'
```

| method        | opções obrigatórias                                                                                      | resposta                                                                          |
|---------------|----------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| `PIX`         | `pix.expiresInSeconds` (opcional, padrão 3600)                                                           | `pix.copyPaste`, `pix.qrCodeImage` (PNG data URL), `pix.txid`                     |
| `BOLETO`      | `boleto.dueDate`, `customer.address`; opcionais: `instructions`, `finePercent` (≤2%), `interestMonthlyPercent` | `boleto.digitableLine(Formatted)`, `barcode`, `nossoNumero`, `pdfUrl`        |
| `CREDIT_CARD` | `card.token`, `installments`, `capture`                                                                  | `card.brand/last4/authorizationCode`; recusa = `201` com `status: FAILED`         |

Outras rotas:
- `GET /v1/payments/:id`: status atual. Com `?refresh=true`, consulta o banco antes de responder.
- `GET /v1/payments/:id/boleto.pdf`: PDF do boleto (ficha de compensação com código de barras ITF).
- `POST /v1/cards/tokens`: tokenização (`number`, `holderName`, `expMonth`, `expYear`, `cvv`), com rate limit de 10/min.

Ciclo de status: `PROCESSING → PENDING | AUTHORIZED | PAID | FAILED`, `PENDING → PAID | EXPIRED | CANCELED`,
`AUTHORIZED → PAID | CANCELED`, `PAID → REFUNDED`. Toda transição gera um `TransactionEvent` (trilha de auditoria).

### 3. Webhooks bancários

| Rota                                                | Uso                                                                   |
|-----------------------------------------------------|-----------------------------------------------------------------------|
| `POST /v1/webhooks/bb` · `POST /v1/webhooks/caixa`  | notificações de boleto/genéricas                                      |
| `.../pix`                                           | a API Pix do BACEN acrescenta `/pix` à URL registrada                 |
| `.../t/:token` · `.../t/:token/pix`                 | segredo no path, para PSPs que descartam a query string               |

A autenticação usa até três camadas, e todas as configuradas precisam passar:
1. **mTLS no proxy** (`WEBHOOK_REQUIRE_MTLS`): nginx, ALB ou Envoy valida o certificado do banco e repassa o resultado em `x-ssl-client-verify`. O proxy **deve sobrescrever** esse header.
2. **Segredo compartilhado** (`WEBHOOK_SECRET_*`): enviado via `?token=`, `x-webhook-token` ou `/t/:token`.
3. **Allowlist de IP/CIDR** (`WEBHOOK_*_ALLOWED_IPS`).

**O payload do webhook nunca é fonte da verdade.** Ele só dispara uma reconsulta autoritativa ao banco
(`SyncPaymentStatusUseCase`). Um payload forjado com txid válido não marca nada como pago; há um teste e2e
para isso. Os eventos são deduplicados pela chave natural (`endToEndId` / nosso número + data).

---

## Segurança implementada

| Requisito                          | Implementação |
|------------------------------------|---------------|
| Credenciais fora do código         | Tabela `convenios`, cifrada com AES-256-GCM (IV aleatório de 96 bits e tag de 128 bits). O **AAD** vincula o ciphertext ao id do convênio. |
| Rotação de chaves                  | `ENCRYPTION_KEYS` é um chaveiro (`id:chave`, …). Novas cifragens usam a chave ativa e as antigas continuam decifrando. |
| mTLS com os bancos                 | Um `undici.Agent` por convênio com `.pfx`/`.pem`, `rejectUnauthorized: true` fixo, TLS ≥ 1.2 e CA extra **somada** às raízes públicas. Testado contra um servidor que exige certificado cliente. |
| Idempotência                       | `Idempotency-Key` obrigatório. A reserva é atômica (UNIQUE merchant+key), com hash canônico do payload, replay da resposta (`Idempotent-Replayed: true`), 422 para chave reutilizada com outro payload e 409 enquanto a requisição estiver em andamento. Uma 2ª barreira (UNIQUE na tabela `transactions`) cobre a recuperação de locks expirados. |
| SQL injection                      | Somente Prisma com queries parametrizadas. Não há `$queryRawUnsafe`. O único SQL cru é `SELECT 1` via tagged template. |
| Sanitização / mass assignment      | `whitelist` + `forbidNonWhitelisted`, NFC, remoção de caracteres de controle e invisíveis, regex de charset, CPF/CNPJ com DV (inclusive **CNPJ alfanumérico**), escape de XML no SOAP e texto bancário em ASCII. |
| PCI-DSS                            | O endpoint de pagamento aceita **somente token**. O PAN/CVV só existe em memória durante a tokenização e é redigido dos logs. A validação nunca ecoa valores. |
| LGPD                               | CPF/CNPJ, e-mail, telefone e endereço do pagador são cifrados. A busca usa *blind index* (HMAC) e as respostas mostram o documento mascarado. |
| API keys                           | Ficam guardadas só como HMAC com pepper. A comparação é em tempo constante, e o HMAC é calculado mesmo quando o prefixo não existe. |
| Anti-SSRF                          | URLs dos convênios: só HTTPS, sem credenciais e com host na allowlist. |
| Hardening HTTP                     | helmet (CSP `default-src 'none'`, HSTS), limite de body de 256 kB, rate limit global e por rota, CORS desligado por padrão, `x-request-id`. |
| Logs                               | pino em JSON, com correlação por request e redação de headers, tokens e segredos. Corpo de requisição e query string de chamadas bancárias nunca são logados. |

### Semântica de falhas bancárias

| Exceção                     | HTTP | Resultado (`outcome`) | Efeito na transação                     |
|-----------------------------|------|-----------------------|-----------------------------------------|
| `BankRejectedError`         | 422  | REJECTED              | `FAILED` (mensagem do banco exposta)    |
| `BankAuthenticationError`   | 502  | NOT_PROCESSED         | `FAILED`                                |
| `BankTlsError`              | 502  | NOT_PROCESSED         | `FAILED`                                |
| `BankRateLimitedError`      | 503  | NOT_PROCESSED         | `FAILED` (pode repetir com nova chave)  |
| `BankUnavailableError`      | 503  | NOT_PROCESSED/UNCERTAIN | conforme o caso                       |
| `BankTimeoutError`          | 504  | UNCERTAIN             | fica `PROCESSING` → reconciliação       |
| `BankInvalidResponseError`  | 502  | UNCERTAIN             | fica `PROCESSING` → reconciliação       |

A transação é gravada **antes** da chamada ao banco (write-ahead), com uma referência determinística
(txid / nosso número). Assim, um timeout nunca vira cobrança perdida nem duplicada: a reconciliação
consulta o banco, completa os dados (linha digitável, copia-e-cola) e ajusta o status. Retries
automáticos só acontecem em operações idempotentes (GET, `PUT /cob/{txid}`, token) ou quando nada
chegou a ser enviado (falha de conexão).

---

## Checklist de homologação (antes de produção)

Os adapters seguem as especificações públicas, mas **precisam ser validados no ambiente de
homologação de cada banco**:

**Banco do Brasil**
- [ ] Confirmar URLs de OAuth/Pix/Cobranças por ambiente no Portal Developers (`bb.config.ts`; todas podem ser sobrescritas por convênio).
- [ ] Confirmar os escopos OAuth (`BB_SCOPES`) liberados para a aplicação.
- [ ] Validar a tabela `codigoEstadoTituloCobranca` → status (`BB_PAID_STATES`) e os campos do GET de boleto.
- [ ] Registrar o webhook Pix (`PUT /pix/v2/webhook/{chave}`) e o de boletos no portal, apontando para `/v1/webhooks/bb/t/<token>`.
- [ ] Testar com o certificado ICP-Brasil A1 real (PFX) cadastrado no portal.

**Caixa**
- [ ] Confirmar endpoints SIBAR, versão do leiaute e `USUARIO_SERVICO` (`caixa.config.ts`).
- [ ] Validar o hash de `AUTENTICACAO` e os campos de `INCLUI_BOLETO` com o manual vigente.
- [ ] Validar os textos de "SITUACAO DO TITULO" no `CONSULTA_BOLETO` (hoje o mapeamento é conservador: o que não for reconhecido continua `PENDING`).
- [ ] Obter URLs, credenciais e certificado da API Pix da Caixa no credenciamento.
- [ ] Conciliação de boleto: o SIGCB não envia webhook. Use a reconciliação ativa e/ou importe o arquivo de retorno CNAB 240 (próximo passo).

**Cartão**
- [ ] Substituir `MockAcquirerAdapter` por um adapter real (Cielo, Rede, Getnet, Stone…) com a mesma interface. A adquirente mock é bloqueada em `PRODUCTION`.
- [ ] Preferir tokenização client-side (SDK JS da adquirente) para que o lojista fique em SAQ A.

---

## Próximos passos sugeridos

- Notificar o lojista quando o status mudar (webhook de saída assinado com HMAC e retries via outbox).
- Importar o arquivo de retorno CNAB 240 (Caixa/BB) para conciliação em lote.
- Estorno/devolução: Pix (`PUT /pix/{e2eid}/devolucao/{id}`), cancelamento/baixa de boleto, captura e cancelamento no cartão.
- Envelope encryption com KMS/HSM (a interface `KeyRing` já isola a origem das chaves) e um job de re-cifragem.
- Circuit breaker por provedor, métricas (Prometheus/OpenTelemetry) e alertas de certificado próximo do vencimento (hoje é log `warn`).
- Back-office com SSO/RBAC no lugar do `ADMIN_API_TOKEN`.
