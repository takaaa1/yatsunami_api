-- Datas de despesa gravadas como "meia-noite UTC" passam para o meio-dia de
-- Brasília do mesmo dia (verificação do code review 2026-11, D2).
--
-- Notas lançadas sem hora (versões antigas do formulário / da leitura da nota
-- fiscal) eram gravadas como `AAAA-MM-DDT00:00:00Z`. Em Brasília isso é 21:00
-- do DIA ANTERIOR: a nota de 01/03 aparecia em 28/02 no detalhe, na dashboard
-- e no filtro por dia. Regra do negócio: todas as datas em GMT-3.
--
-- Meio-dia é a mesma convenção de `dataDaVendaDoFormulario` e de
-- `instanteDeHorarioLocal` para "só a data": não escorrega para o dia vizinho.
--
-- Verificado em produção antes (consulta só de leitura, 2026-11-18): 50 de 64
-- notas afetadas; nenhuma das outras 14 tem hora 00:00:00 UTC.
UPDATE "notas_despesa"
SET "data_compra" = (("data_compra" AT TIME ZONE 'UTC')::date + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo'
WHERE "data_compra" IS NOT NULL
  AND ("data_compra" AT TIME ZONE 'UTC')::time = TIME '00:00';
