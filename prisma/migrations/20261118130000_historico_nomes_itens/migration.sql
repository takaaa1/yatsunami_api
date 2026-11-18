-- Histórico concreto dos itens (verificação do code review 2026-11, D1 e #9).
--
-- Cada item de venda, de pedido encomenda e de pedido direto passa a guardar o
-- NOME do produto e da variedade no momento em que foi vendido/pedido — como já
-- guardava o preço (`preco_unitario`). Renomear, desativar ou excluir algo no
-- catálogo não muda mais o que o histórico mostra.

ALTER TABLE "itens_venda"            ADD COLUMN "produto_nome" JSON, ADD COLUMN "variedade_nome" JSON;
ALTER TABLE "itens_pedido_encomenda" ADD COLUMN "produto_nome" JSON, ADD COLUMN "variedade_nome" JSON;
ALTER TABLE "itens_pedido_direto"    ADD COLUMN "produto_nome" JSON, ADD COLUMN "variedade_nome" JSON;

-- Preenchimento retroativo com os nomes atuais do catálogo. Verificado em
-- produção antes (2026-11-18, só leitura): nenhum item perdeu a variedade, então
-- todo item com variedade recebe o nome dela.
UPDATE "itens_venda" i            SET "produto_nome" = p."nome" FROM "produtos" p WHERE p."id" = i."produto_id";
UPDATE "itens_pedido_encomenda" i SET "produto_nome" = p."nome" FROM "produtos" p WHERE p."id" = i."produto_id";
UPDATE "itens_pedido_direto" i    SET "produto_nome" = p."nome" FROM "produtos" p WHERE p."id" = i."produto_id";

UPDATE "itens_venda" i            SET "variedade_nome" = v."nome" FROM "variedades_produto" v WHERE v."id" = i."variedade_id";
UPDATE "itens_pedido_encomenda" i SET "variedade_nome" = v."nome" FROM "variedades_produto" v WHERE v."id" = i."variedade_id";
UPDATE "itens_pedido_direto" i    SET "variedade_nome" = v."nome" FROM "variedades_produto" v WHERE v."id" = i."variedade_id";

-- #9: o índice único (data_encomenda_id, produto_id, variedade_id) não impede o
-- mesmo produto SEM variedade duas vezes, porque NULLs são distintos. Este
-- índice parcial cobre esse caso. Verificado em produção antes: 0 duplicatas.
CREATE UNIQUE INDEX "produtos_encomenda_sem_variedade_key"
  ON "produtos_encomenda" ("data_encomenda_id", "produto_id")
  WHERE "variedade_id" IS NULL;
