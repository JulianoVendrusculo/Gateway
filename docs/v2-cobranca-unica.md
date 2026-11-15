# v2 — Cobrança única

Uma inscrição de concurso tem uma única obrigação de pagamento. Na v1 cada pagamento era independente,
então a mesma inscrição podia gerar vários boletos, ser paga por dois métodos ou ter o mesmo link de
cartão pago duas vezes. A `Idempotency-Key` só protege contra o mesmo clique enviado duas vezes.

Na v2, **uma inscrição é uma `Charge`** e Pix, boleto e cartão são **tentativas** (`Transaction`) dentro
dela. Este documento descreve o desenho, o que mudou, o que está simulado e o que falta validar.

## Regras

1. Uma `Charge` por lojista e `externalReference` (o id da inscrição).
2. No máximo **uma tentativa ativa** por `Charge`. Ativa = `PENDENTE`, `PROCESSANDO` ou `EM_VERIFICACAO`.
3. Pedir de novo o mesmo método, com a tentativa ainda válida, devolve **a mesma** tentativa.
4. Trocar de método exige cancelar a tentativa ativa no banco **e o banco confirmar** (`cancel()` seguido de
   `getStatus()`). Sem confirmação, a troca é bloqueada.
5. **A primeira confirmação vence.** A transação vira `CONFIRMADA`, a `Charge` vira `PAGA` e as outras
   tentativas são canceladas no banco (com nova tentativa automática se falhar).
6. Pagamento de uma `Charge` já paga não se perde: vira `PAGO_DUPLICADO` e abre um `Refund` em
   `PENDENTE_ANALISE`. **Nenhum estorno é feito automaticamente.**
7. Tentativa vencida não libera a cobrança direto: fica `EM_VERIFICACAO` por uma janela de tolerância.

## Onde cada regra é garantida

| Regra | Aplicação | Banco de dados |
|---|---|---|
| Uma `Charge` por inscrição | `ChargeRepository.withLockedChargeByReference` (`INSERT ... ON CONFLICT`) | `UNIQUE (merchant_id, external_reference)` |
| Uma tentativa ativa | decisão com a `Charge` bloqueada | índice único parcial `transactions_one_active_per_charge` |
| Uma confirmada | `PaymentSettlementService.settle` | índice único parcial `transactions_one_confirmed_per_charge` |
| `Charge` paga aponta para quem pagou | `settle` | `CHECK charges_paid_has_transaction`, `UNIQUE paid_transaction_id` |
| Mesmo pagamento não é registrado duas vezes | `settle` (id do pagamento) e `webhook_events` | `UNIQUE (convenio_id, provider_payment_id)`, `UNIQUE (provider, event_key)` |

Os índices parciais só existem na migration, em SQL: o Prisma não os representa no schema.

### O lock, e por que ele não fica aberto durante a chamada ao banco

Toda decisão sobre uma `Charge` roda em uma transação que bloqueia a linha dela com `SELECT ... FOR UPDATE`:
criar tentativa, confirmar pagamento, cancelar, expirar. Duas requisições, dois webhooks, ou um webhook e o
job nunca decidem ao mesmo tempo.

O enunciado pedia "tudo em uma transação". **O lock não fica aberto durante o HTTP para o banco, de
propósito.** Se a transação expirasse ou o processo caísse no meio da chamada, o rollback apagaria o
registro de uma cobrança que o banco já criou, e ninguém saberia que ela existe. Em vez disso:

1. com o lock, a tentativa é gravada como `PROCESSANDO` (o que já a torna a única ativa) e a transação fecha;
2. o banco é chamado sem lock;
3. com um novo lock, o resultado é aplicado.

No intervalo, quem tentar outra coisa na mesma `Charge` encontra a tentativa `PROCESSANDO` e recebe
`409 TENTATIVA_EM_ANDAMENTO`. Se o processo cair, a tentativa continua gravada e o job descobre no banco o
que aconteceu. O mesmo vale para a troca de método, que marca `cancel_requested_at` na tentativa antiga.

## Estados

**Tentativa (`Transaction.status`)**

| Status | Significado | Bloqueia a cobrança? |
|---|---|---|
| `PROCESSANDO` | enviada ao banco, resultado ainda desconhecido | sim |
| `PENDENTE` | registrada no banco, aguardando pagamento | sim |
| `EM_VERIFICACAO` | venceu; aguardando a janela de tolerância | sim |
| `CONFIRMADA` | pagamento confirmado; é a que quitou a cobrança | — |
| `CANCELADA` | cancelamento confirmado pelo banco | não |
| `EXPIRADA` | venceu e a janela passou sem pagamento | não |
| `FALHOU` | o banco recusou, ou nunca chegou a registrar | não |
| `PAGO_DUPLICADO` | pagamento de cobrança que já estava paga | — |

`CANCELADA`, `EXPIRADA` e `FALHOU` ainda aceitam um pagamento tardio (`→ CONFIRMADA` ou `→ PAGO_DUPLICADO`).

**Cobrança (`Charge.status`)**: `ABERTA`, `PAGA`, `CANCELADA`, `EXPIRADA`. Uma cobrança encerrada que
recebe pagamento vira `PAGA` (com aviso em log), porque o dinheiro entrou. Nenhum fluxo grava `CANCELADA`
ainda; o valor existe para a futura rota de cancelamento.

## Comportamento por método

**Pix.** Ativo enquanto o QR Code vale. Na troca de método a cobrança é removida no banco; se o banco
informar que ela já foi paga, isso vale como confirmação. Quando vence, o banco é consultado antes de
liberar. Conferido na especificação oficial do Bacen (ver "Fontes").

**Boleto.** Ativo da geração até o fim do último dia em que pode ser pago (vencimento mais
`acceptUntilDaysAfterDue`), no horário de Brasília. Pedir boleto de novo devolve o mesmo. Na troca de método
o gateway pede a baixa e confirma pela consulta do título. Duas liquidações do mesmo boleto: a segunda vira
uma linha `PAGO_DUPLICADO` ligada à original.

**Cartão (`HOSTED_LINK`).** O pagador sai da plataforma e paga na página do banco. O link é a tentativa
ativa; pedir cartão de novo devolve o mesmo link. A validade é curta e configurável
(`CARD_LINK_TTL_SECONDS`, padrão 15 minutos). A confirmação chega por webhook, possivelmente atrasada.
- Troca de método: o link é invalidado pela API do provedor e só então a troca é liberada. Se o provedor
  não oferece cancelamento, a troca fica bloqueada até o link expirar, a resposta traz
  `details.limitation: true` e o evento `cancel.unsupported` fica registrado.
- Link vencido: o job consulta o provedor. Se constar pago, confirma. Se não, a tentativa fica
  `EM_VERIFICACAO` por `VERIFICATION_WINDOW_CARD_SECONDS`, é reconsultada a cada ciclo, e só ao fim da
  janela vira `EXPIRADA`.
- O modo `DIRECT` existe só como tipo no contrato (`CardMode`, `DirectCardChargeRequest`).

## API: o que mudou da v1 para a v2

| | v1 | v2 |
|---|---|---|
| `externalReference` | opcional | **obrigatório** (id da inscrição) |
| Segundo `POST` da mesma inscrição | cria outro pagamento | devolve a mesma tentativa (`200`), troca de método, ou `409` |
| Valor diferente para a mesma inscrição | aceito | `422 COBRANCA_VALOR_DIVERGENTE` |
| Status | `PENDING`, `PAID`, `FAILED`… | `PENDENTE`, `CONFIRMADA`, `FALHOU`… |
| Cartão | token + autorização imediata | link (`card.paymentUrl`), confirmação por webhook |
| `POST /v1/cards/tokens` | recebe o número do cartão | **não existe** (o gateway não toca em PAN) |
| `GET /v1/charges/:externalReference` | — | cobrança, tentativa ativa, histórico e estornos pendentes |
| Resposta do `POST` | `201` | `201` (nova) ou `200` (`reused: true`) |
| Erros novos | — | `PAGAMENTO_JA_CONFIRMADO`, `TENTATIVA_EM_ANDAMENTO`, `CANCELAMENTO_RECUSADO`, `COBRANCA_VALOR_DIVERGENTE`, `COBRANCA_ENCERRADA` |
| Contrato dos provedores | `createCharge`, `getChargeStatus` | `createCharge`, `getStatus`, `cancel` |

A `Idempotency-Key` continua obrigatória e com o mesmo comportamento.

## Configuração nova

| Variável | Padrão | Para que serve |
|---|---|---|
| `CARD_LINK_TTL_SECONDS` | 900 | validade do link de cartão |
| `VERIFICATION_WINDOW_PIX_SECONDS` | 60 | tolerância depois do vencimento do QR Code |
| `VERIFICATION_WINDOW_BOLETO_SECONDS` | 259200 (3 dias) | tolerância depois do último dia de pagamento, para cobrir a compensação |
| `VERIFICATION_WINDOW_CARD_SECONDS` | 1800 | tolerância depois do vencimento do link, para cobrir o atraso do webhook |
| `WEBHOOK_SECRET_MOCK_ACQUIRER` | — | segredo do webhook do provedor simulado |

Os padrões das janelas são um ponto de partida, não um dado dos bancos.

## Migrations e convivência com a v1

Duas migrations, ambas aditivas:
- `20261115050000_v2_enum_values`: tipos novos e os oito status novos em `TransactionStatus`. Fica separada
  porque o PostgreSQL não deixa usar um valor de enum na transação em que ele nasce.
- `20261115050100_v2_cobranca_unica`: tabelas `charges` e `refunds`, colunas anuláveis em `transactions`,
  índices únicos parciais e constraints.

Nada da v1 é removido nem alterado. As transações antigas ficam com `charge_id` nulo e os status antigos;
uma constraint impede que os dois vocabulários se misturem. A v2 as lê (`GET /v1/payments/:id`), mas **não
as concilia nem aceita webhook delas**.

**A virada não está nesta entrega.** Substituir a v1 exige um backfill que cria uma `Charge` para cada
transação existente e converte os status. Ele depende de decisão de negócio: quando a v1 já tem dois
pagamentos confirmados para a mesma inscrição, qual quita a cobrança e qual vira `PAGO_DUPLICADO`. Até lá,
transações abertas da v1 precisam ser acompanhadas pela v1.

## O que está simulado

- **Todo o link de cartão.** `MockAcquirerAdapter` cria links, responde consultas e cancelamentos e emite o
  webhook de pagamento. O comportamento é configurável por convênio (`cancelBehavior`: `ACCEPT`,
  `UNSUPPORTED`, `REFUSE`, `ERROR`; `createBehavior`: `OK`, `TIMEOUT`) e por ganchos de teste
  (`simulatePayment`, com `force` para pagamento tardio e pagamento em dobro; `simulateExpiration`).
  É bloqueado em produção e guarda os links em memória.
- **Os bancos, nos testes.** `test/support/fake-bb-bank.ts` simula OAuth, Pix e Cobranças do BB sobre
  HTTPS com mTLS, incluindo remoção de cobrança e baixa de boleto com resposta configurável
  (`cancelBehavior`). A Caixa só tem testes unitários.

## Pendências a validar com cada banco

**Banco do Brasil**
- [ ] Baixa de boleto: conferir na referência oficial o corpo de `POST /boletos/{id}/baixar`, os códigos de
      erro e o escopo exigido. O portal de desenvolvedores não pôde ser lido nesta entrega.
- [ ] Boleto recém-pago (pago hoje em outro banco, ainda em compensação): o banco aceita a baixa? Em que
      momento o título passa a constar como liquidado na consulta?
- [ ] Depois de quanto tempo a baixa aparece na consulta (estado 7). Se não for imediato, a troca de método
      responde `CANCELAMENTO_RECUSADO` até aparecer.
- [ ] Webhook de baixa operacional: qual campo identifica cada liquidação. Hoje é data e hora
      (`dataLiquidacao`); duas notificações com horários diferentes são tratadas como dois pagamentos.
- [ ] Prazo real de compensação do convênio, para calibrar `VERIFICATION_WINDOW_BOLETO_SECONDS`.
- [ ] Comportamento do PSP ao remover uma cobrança Pix no instante em que ela é paga.

**Caixa**
- [ ] `BAIXA_BOLETO`: conferir no manual do webservice a estrutura da mensagem, o `SOAPAction` e o cálculo
      do hash de autenticação. O manual não pôde ser baixado nesta entrega.
- [ ] Mesmas perguntas do BB sobre boleto recém-pago e sobre o prazo de compensação.
- [ ] O SIGCB não envia webhook nem identifica cada liquidação na consulta: uma segunda liquidação do mesmo
      boleto **não é detectada** hoje. Depende do arquivo de retorno (CNAB 240).
- [ ] Código de retorno de "título inexistente", para encerrar tentativas `PROCESSANDO` que nunca foram
      registradas (hoje ficam bloqueando a cobrança, com o alerta `TENTATIVA_PRESA` depois de uma hora).
- [ ] URLs, credenciais e certificado da API Pix.

**Cartão (os dois bancos)**
- [ ] Qual é o produto de link de pagamento e qual adquirente está por trás. Nenhuma API oficial de link de
      cartão do BB ou da Caixa foi identificada.
- [ ] Existe API para invalidar um link? A invalidação é imediata?
- [ ] Validade mínima e máxima do link.
- [ ] Um mesmo link pode ser pago mais de uma vez?
- [ ] Atraso típico e máximo do webhook de confirmação, para calibrar `VERIFICATION_WINDOW_CARD_SECONDS`.
- [ ] Formato e autenticação do webhook, e se há consulta de status por id do pedido.

## Limitações conhecidas

- A liquidação é detectada como duplicada só quando o provedor identifica o pagamento ou quando chega um
  evento distinto. Sem isso, dois pagamentos da mesma tentativa parecem um só.
- Se o banco ainda aceitar o pagamento de uma tentativa que o gateway já expirou e o cancelamento falhar,
  a cobrança é liberada mesmo assim (há aviso em log). Um pagamento posterior é tratado como tardio.
- Os estornos pendentes só são visíveis pela consulta da cobrança e pela tabela `refunds`.

## Fontes

- Pix: especificação OpenAPI do Banco Central, `https://github.com/bacen/pix-api` (`openapi.yaml`).
  `PATCH /cob/{txid}` aceita `status` com o único valor `REMOVIDA_PELO_USUARIO_RECEBEDOR`; se a cobrança
  não estiver `ATIVA` a resposta é 400 `CobOperacaoInvalida`; `CONCLUIDA` "não pode acolher outro
  pagamento"; o status é do registro, e uma cobrança vencida continua `ATIVA`.
- BB e Caixa: as páginas oficiais não puderam ser lidas (o portal do BB depende de JavaScript e o PDF da
  Caixa recusa acesso automatizado). O que foi implementado está marcado com `TODO(homologação)` no código.
