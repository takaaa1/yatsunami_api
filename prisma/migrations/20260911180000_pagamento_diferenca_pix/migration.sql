-- Pagamento da diferença via PIX (docs/PAGAMENTO-DIFERENCA-PIX.md na raiz do workspace).
--
-- Antes, editar um pedido já pago fazia o QR cobrar o total inteiro de novo:
-- `update()` sobrescreve total_valor e nada registrava o que já tinha sido pago.

ALTER TABLE "pedidos_encomenda"
  ADD COLUMN "valor_pago" DECIMAL(10,2),
  ADD COLUMN "reembolso_valor" DECIMAL(10,2),
  ADD COLUMN "reembolsado_em" TIMESTAMPTZ(6),
  ADD COLUMN "reembolsado_por" TEXT;

CREATE TABLE "comprovantes_pedido" (
  "id" SERIAL NOT NULL,
  "pedido_encomenda_id" INTEGER NOT NULL,
  "url" VARCHAR(1000) NOT NULL,
  "valor" DECIMAL(10,2) NOT NULL,
  "tipo" VARCHAR(20) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'em_analise',
  "criado_em" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "comprovantes_pedido_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "comprovantes_pedido_pedido_encomenda_id_idx"
  ON "comprovantes_pedido"("pedido_encomenda_id");

ALTER TABLE "comprovantes_pedido"
  ADD CONSTRAINT "comprovantes_pedido_pedido_encomenda_id_fkey"
  FOREIGN KEY ("pedido_encomenda_id") REFERENCES "pedidos_encomenda"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Histórico inicial: o comprovante que cada pedido já tem vira o primeiro
-- registro. Só onde o status diz o que ele é — em análise ou confirmado.
-- Pedido pendente ou cancelado com comprovante (revertido antes deste recurso)
-- fica de fora: não há como saber se aquele valor chegou a valer. O arquivo
-- segue acessível pelo `comprovante_url` do próprio pedido.
INSERT INTO "comprovantes_pedido"
  ("pedido_encomenda_id", "url", "valor", "tipo", "status", "criado_em")
SELECT
  "id",
  "comprovante_url",
  "total_valor",
  'integral',
  CASE WHEN "status_pagamento" = 'aguardando_confirmacao' THEN 'em_analise' ELSE 'confirmado' END,
  COALESCE("data_pagamento", "data_pedido")
FROM "pedidos_encomenda"
WHERE "comprovante_url" IS NOT NULL
  AND "status_pagamento" IN ('aguardando_confirmacao', 'confirmado', 'entregue');
