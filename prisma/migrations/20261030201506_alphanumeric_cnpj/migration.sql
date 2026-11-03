-- CNPJ alfanumérico (IN RFB nº 2.229/2024): 12 posições [0-9A-Z] + 2 DVs numéricos.
ALTER TABLE "merchants" DROP CONSTRAINT "merchants_document_digits";
ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_document_format" CHECK ("document" ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$');
