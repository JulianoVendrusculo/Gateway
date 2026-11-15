-- v2 (cobrança única), parte 2 de 2: Charge, Refund e as garantias de unicidade.
--
-- Aditiva: só cria tabelas, colunas anuláveis (ou com default), índices e constraints.
-- As transações da v1 ficam como estão, com charge_id nulo e os status antigos.

-- ---------------------------------------------------------------------------
-- Charge: a obrigação de pagamento única (uma inscrição)
-- ---------------------------------------------------------------------------
CREATE TABLE "charges" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "external_reference" VARCHAR(64) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "status" "ChargeStatus" NOT NULL DEFAULT 'ABERTA',
    "paid_transaction_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "charges_merchant_id_external_reference_key" ON "charges"("merchant_id", "external_reference");
CREATE UNIQUE INDEX "charges_paid_transaction_id_key" ON "charges"("paid_transaction_id");
CREATE INDEX "charges_status_expires_at_idx" ON "charges"("status", "expires_at");

-- ---------------------------------------------------------------------------
-- Transaction passa a ser uma tentativa dentro de uma Charge
-- ---------------------------------------------------------------------------
ALTER TABLE "transactions"
  ADD COLUMN "charge_id" UUID,
  ADD COLUMN "provider_payment_id" VARCHAR(128),
  ADD COLUMN "duplicate_of_id" UUID,
  ADD COLUMN "verification_until" TIMESTAMPTZ(3),
  ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3),
  ADD COLUMN "cancel_reason" VARCHAR(32),
  ADD COLUMN "cancel_attempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "transactions_charge_id_created_at_idx" ON "transactions"("charge_id", "created_at");
CREATE INDEX "transactions_status_expires_at_idx" ON "transactions"("status", "expires_at");
CREATE UNIQUE INDEX "transactions_convenio_id_provider_payment_id_key" ON "transactions"("convenio_id", "provider_payment_id");

-- ---------------------------------------------------------------------------
-- Refund: pendência de estorno de pagamento duplicado (nunca executada automaticamente)
-- ---------------------------------------------------------------------------
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDENTE_ANALISE',
    "reason" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refunds_transaction_id_key" ON "refunds"("transaction_id");
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at");

-- ---------------------------------------------------------------------------
-- Chaves estrangeiras
-- ---------------------------------------------------------------------------
ALTER TABLE "charges" ADD CONSTRAINT "charges_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "charges" ADD CONSTRAINT "charges_paid_transaction_id_fkey" FOREIGN KEY ("paid_transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- As duas regras centrais da v2, garantidas pelo banco de dados.
-- São índices únicos PARCIAIS, que o Prisma não representa no schema: existem só aqui.
-- Mesmo que a aplicação erre ou duas instâncias corram juntas, a segunda escrita falha.
-- ---------------------------------------------------------------------------

-- No máximo UMA transação confirmada por Charge (a primeira confirmação vence).
CREATE UNIQUE INDEX "transactions_one_confirmed_per_charge"
  ON "transactions"("charge_id")
  WHERE "status" = 'CONFIRMADA';

-- No máximo UMA tentativa ativa por Charge.
CREATE UNIQUE INDEX "transactions_one_active_per_charge"
  ON "transactions"("charge_id")
  WHERE "status" IN ('PENDENTE', 'PROCESSANDO', 'EM_VERIFICACAO');

-- ---------------------------------------------------------------------------
-- Invariantes (defesa em profundidade, como na v1)
-- ---------------------------------------------------------------------------
ALTER TABLE "charges"
  ADD CONSTRAINT "charges_amount_positive" CHECK ("amount_cents" > 0),
  ADD CONSTRAINT "charges_currency_brl" CHECK ("currency" = 'BRL'),
  -- Charge paga sempre aponta para a transação que a quitou, e só ela aponta.
  ADD CONSTRAINT "charges_paid_has_transaction" CHECK (("status" = 'PAGA') = ("paid_transaction_id" IS NOT NULL));

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_cancel_attempts_non_negative" CHECK ("cancel_attempts" >= 0),
  -- Vocabulários não se misturam: linha da v1 (sem Charge) usa status da v1; tentativa da v2 usa os novos.
  ADD CONSTRAINT "transactions_status_matches_generation" CHECK (
    ("charge_id" IS NULL) = ("status" IN ('PROCESSING', 'PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED'))
  ),
  -- Linha que registra o segundo pagamento de uma tentativa é sempre PAGO_DUPLICADO.
  ADD CONSTRAINT "transactions_duplicate_is_flagged" CHECK ("duplicate_of_id" IS NULL OR "status" = 'PAGO_DUPLICADO');

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_cents" > 0);
