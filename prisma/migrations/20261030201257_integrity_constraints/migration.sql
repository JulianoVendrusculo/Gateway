-- Defesa em profundidade: invariantes de negócio garantidas também pelo banco.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount_cents" > 0),
  ADD CONSTRAINT "transactions_paid_amount_non_negative" CHECK ("paid_amount_cents" IS NULL OR "paid_amount_cents" >= 0),
  ADD CONSTRAINT "transactions_currency_brl" CHECK ("currency" = 'BRL'),
  ADD CONSTRAINT "transactions_version_positive" CHECK ("version" > 0);

ALTER TABLE "convenios"
  ADD CONSTRAINT "convenios_supported_methods_not_empty" CHECK (cardinality("supported_methods") > 0),
  ADD CONSTRAINT "convenios_nosso_numero_non_negative" CHECK ("nosso_numero_sequence" >= 0);

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_document_digits" CHECK ("document" ~ '^[0-9]{11}([0-9]{3})?$');

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_completed_has_response"
  CHECK ("status" <> 'COMPLETED' OR ("response_status" IS NOT NULL AND "response_body" IS NOT NULL));
