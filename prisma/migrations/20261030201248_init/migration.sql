-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('BANCO_DO_BRASIL', 'CAIXA', 'MOCK_ACQUIRER');

-- CreateEnum
CREATE TYPE "ProviderEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'BOLETO', 'CREDIT_CARD');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PROCESSING', 'PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CPF', 'CNPJ');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransactionEventSource" AS ENUM ('API', 'WEBHOOK', 'RECONCILIATION', 'SYSTEM');

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "trade_name" VARCHAR(120),
    "document_type" "DocumentType" NOT NULL,
    "document" VARCHAR(14) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "api_key_prefix" VARCHAR(32) NOT NULL,
    "api_key_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "convenios" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "environment" "ProviderEnvironment" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "supported_methods" "PaymentMethod"[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "credentials_ciphertext" TEXT NOT NULL,
    "certificate_ciphertext" TEXT,
    "credentials_version" INTEGER NOT NULL DEFAULT 1,
    "encryption_key_id" VARCHAR(32) NOT NULL,
    "certificate_fingerprint" VARCHAR(64),
    "certificate_subject" VARCHAR(512),
    "certificate_expires_at" TIMESTAMPTZ(3),
    "nosso_numero_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "convenios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "name" VARCHAR(140) NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "document_hash" CHAR(64) NOT NULL,
    "document_masked" VARCHAR(20) NOT NULL,
    "pii_ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "convenio_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_amount_cents" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "description" VARCHAR(140),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "external_reference" VARCHAR(64),
    "provider_reference" VARCHAR(64),
    "provider_data" JSONB,
    "metadata" JSONB,
    "failure_code" VARCHAR(64),
    "failure_message" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "sync_locked_until" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_events" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "from_status" "TransactionStatus",
    "to_status" "TransactionStatus",
    "source" "TransactionEventSource" NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "transaction_id" UUID,
    "locked_until" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "event_key" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "provider_reference" VARCHAR(64),
    "transaction_id" UUID,
    "status" "WebhookEventStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "error_message" VARCHAR(500),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_document_key" ON "merchants"("document");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_api_key_prefix_key" ON "merchants"("api_key_prefix");

-- CreateIndex
CREATE INDEX "convenios_merchant_id_is_active_priority_idx" ON "convenios"("merchant_id", "is_active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "customers_merchant_id_document_hash_key" ON "customers"("merchant_id", "document_hash");

-- CreateIndex
CREATE INDEX "transactions_merchant_id_created_at_idx" ON "transactions"("merchant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_merchant_id_external_reference_idx" ON "transactions"("merchant_id", "external_reference");

-- CreateIndex
CREATE INDEX "transactions_provider_provider_reference_idx" ON "transactions"("provider", "provider_reference");

-- CreateIndex
CREATE INDEX "transactions_status_last_synced_at_idx" ON "transactions"("status", "last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_merchant_id_idempotency_key_key" ON "transactions"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_convenio_id_provider_reference_key" ON "transactions"("convenio_id", "provider_reference");

-- CreateIndex
CREATE INDEX "transaction_events_transaction_id_created_at_idx" ON "transaction_events"("transaction_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_merchant_id_key_key" ON "idempotency_keys"("merchant_id", "key");

-- CreateIndex
CREATE INDEX "webhook_events_status_received_at_idx" ON "webhook_events"("status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_key_key" ON "webhook_events"("provider", "event_key");

-- AddForeignKey
ALTER TABLE "convenios" ADD CONSTRAINT "convenios_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_convenio_id_fkey" FOREIGN KEY ("convenio_id") REFERENCES "convenios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
