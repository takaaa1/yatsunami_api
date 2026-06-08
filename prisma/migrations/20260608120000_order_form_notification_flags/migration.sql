-- Add scheduled notification flags to datas_encomenda
ALTER TABLE "datas_encomenda"
  ADD COLUMN "notificar_usuarios" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notificacao_enviada_em" TIMESTAMPTZ(6);

-- Existing rows: treat as already-notified to avoid retroactive blasts
UPDATE "datas_encomenda"
SET "notificacao_enviada_em" = COALESCE("criado_em", NOW())
WHERE "notificacao_enviada_em" IS NULL;
