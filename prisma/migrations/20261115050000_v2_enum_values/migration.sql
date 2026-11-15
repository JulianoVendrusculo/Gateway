-- v2 (cobrança única), parte 1 de 2: tipos.
--
-- Fica separada da parte 2 porque o PostgreSQL não permite usar um valor de enum na mesma
-- transação em que ele foi criado, e a parte 2 usa os novos status em índices e constraints.
--
-- Aditiva: os valores da v1 continuam no tipo e nenhuma linha existente é alterada.

CREATE TYPE "ChargeStatus" AS ENUM ('ABERTA', 'PAGA', 'CANCELADA', 'EXPIRADA');

CREATE TYPE "RefundStatus" AS ENUM ('PENDENTE_ANALISE');

ALTER TYPE "TransactionStatus" ADD VALUE 'PENDENTE';
ALTER TYPE "TransactionStatus" ADD VALUE 'PROCESSANDO';
ALTER TYPE "TransactionStatus" ADD VALUE 'EM_VERIFICACAO';
ALTER TYPE "TransactionStatus" ADD VALUE 'CONFIRMADA';
ALTER TYPE "TransactionStatus" ADD VALUE 'CANCELADA';
ALTER TYPE "TransactionStatus" ADD VALUE 'EXPIRADA';
ALTER TYPE "TransactionStatus" ADD VALUE 'FALHOU';
ALTER TYPE "TransactionStatus" ADD VALUE 'PAGO_DUPLICADO';
