-- Abreviação da variedade: texto curto do cabeçalho da coluna no PDF de resumo
-- de pedidos, como já existe em `produtos.abreviacao`. Opcional: sem ela, o PDF
-- usa a abreviação (ou o nome encurtado) do produto mais o nome da variedade.
--
-- Rodar ANTES de publicar a API que lê a coluna: o Prisma seleciona todas as
-- colunas do modelo, e sem esta a leitura de variedades falharia.

ALTER TABLE "variedades_produto" ADD COLUMN "abreviacao" VARCHAR(50);
