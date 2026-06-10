-- Performance indexes for frequent WHERE/ORDER BY columns (non-blocking on deploy via IF NOT EXISTS pattern)

CREATE INDEX IF NOT EXISTS "usuarios_role_ativo_idx" ON "usuarios"("role", "ativo");

CREATE INDEX IF NOT EXISTS "datas_encomenda_ativo_concluido_idx" ON "datas_encomenda"("ativo", "concluido");
CREATE INDEX IF NOT EXISTS "datas_encomenda_data_limite_pedido_idx" ON "datas_encomenda"("data_limite_pedido");

CREATE INDEX IF NOT EXISTS "pedidos_encomenda_data_encomenda_id_idx" ON "pedidos_encomenda"("data_encomenda_id");
CREATE INDEX IF NOT EXISTS "pedidos_encomenda_data_encomenda_id_status_pagamento_idx" ON "pedidos_encomenda"("data_encomenda_id", "status_pagamento");
CREATE INDEX IF NOT EXISTS "pedidos_encomenda_usuario_id_data_pedido_idx" ON "pedidos_encomenda"("usuario_id", "data_pedido");

CREATE INDEX IF NOT EXISTS "vendas_data_idx" ON "vendas"("data");
CREATE INDEX IF NOT EXISTS "vendas_usuario_id_idx" ON "vendas"("usuario_id");

CREATE INDEX IF NOT EXISTS "pedidos_diretos_usuario_id_idx" ON "pedidos_diretos"("usuario_id");
CREATE INDEX IF NOT EXISTS "pedidos_diretos_usuario_id_status_idx" ON "pedidos_diretos"("usuario_id", "status");
CREATE INDEX IF NOT EXISTS "pedidos_diretos_data_pedido_idx" ON "pedidos_diretos"("data_pedido");

CREATE INDEX IF NOT EXISTS "entregador_localizacao_form_id_idx" ON "entregador_localizacao"("form_id");
CREATE INDEX IF NOT EXISTS "entregador_localizacao_form_id_courier_id_idx" ON "entregador_localizacao"("form_id", "courier_id");

CREATE INDEX IF NOT EXISTS "notificacoes_usuario_id_criado_em_idx" ON "notificacoes"("usuario_id", "criado_em");
CREATE INDEX IF NOT EXISTS "notificacoes_usuario_id_lido_idx" ON "notificacoes"("usuario_id", "lido");
