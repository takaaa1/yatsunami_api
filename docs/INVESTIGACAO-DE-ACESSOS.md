# Investigação de acessos

Runbook para responder à pergunta "quem fez isto?" sobre um registo em produção.
Escrito depois da investigação da venda 312 (2026-08-23), em que a autoria só foi
determinada por correlação manual de timestamps — as lacunas que a tornaram
difícil estão corrigidas e listadas em [O que mudou](#o-que-mudou).

## Onde estão os rastos

| Fonte | O que tem | Retenção |
|---|---|---|
| `/var/log/nginx/access.log*` (host) | IP real do cliente, método, rota, status, User-Agent | 14 dias (logrotate) |
| `docker logs yatsunami_api_<slot>` | log da app: **id do utilizador**, papel, IP, `X-Request-Id` | slot corrente (rotação 50 MB × 5) |
| `/var/www/yatsunami/logs/*.log.gz` | logs de slots já removidos, arquivados a cada deploy | últimos 30 ficheiros |
| Base de dados | `criado_por` (quem executou) vs `usuario_id` (cliente da venda) | permanente |

> `criado_por` e `usuario_id` não são a mesma coisa. Vendas criadas a partir de um
> Pedido Express gravam `usuario_id = dono do pedido` e `criado_por = admin que
> marcou como entregue` (`express-orders.service.ts`). Confundir os dois faz uma
> operação normal parecer acesso indevido.

## Procedimento

**1. Fixar o instante e o autor segundo a base de dados.**

```bash
ssh takaaa1@187.127.30.181
cd /var/www/yatsunami/api
PGURL=$(grep -E '^DATABASE_URL=' .env | sed -e 's/^DATABASE_URL=//' -e 's/^"//' -e 's/"$//')
psql "$PGURL" -c "SELECT v.id, v.criado_em, v.total, v.usuario_id, v.criado_por,
  uc.email AS criador, uc.role FROM vendas v
  LEFT JOIN usuarios uc ON uc.id = v.criado_por WHERE v.id = <ID>;"
```

**2. Ler o log da aplicação nesse minuto.** A linha traz o id do utilizador — não
é preciso inferir nada:

```bash
docker logs yatsunami_api_b --since 2026-08-23T20:50:00 --until 2026-08-23T21:00:00 2>&1 |
  grep 'user=<UUID>'
```

Formato: `POST /api/sales 201 1510 - 42ms - ip=<ip> user=<uuid>/<papel> req=<uuid> "<user-agent>"`

Se o período for anterior ao último deploy, o slot foi removido — procurar no
arquivo em `/var/www/yatsunami/logs/`.

**3. Confirmar a origem no nginx do host**, que regista o IP real do cliente:

```bash
sudo zgrep -h 'api/sales' /var/log/nginx/access.log*
```

**4. Comparar o User-Agent com a build em uso.** O UA do app nativo é
`Yatsunami/<build> CFNetwork/... Darwin/...`. Uma build antiga a autenticar-se com
a conta de teste é quase sempre a App Review da Apple, não um intruso — a conta
`developer_tester@yatsunami.com` tem papel `admin` e o que os revisores fazem
grava dados reais.

## O que mudou

- **`LoggingInterceptor`** — passou a registar `user=<id>/<papel>`, o IP do cliente
  e um `X-Request-Id` (devolvido no header, para ligar o relato de um utilizador à
  linha do log). Também regista pedidos que falham: antes, um 401 ou um 500 não
  deixava rasto nenhum.
- **`main.ts`** — `trust proxy` configurado (`TRUST_PROXY_HOPS`, por omissão 3:
  Cloudflare → nginx do host → nginx do slot). Sem isto `req.ip` era sempre
  `127.0.0.1`. A contagem é feita da direita para a esquerda, por isso um
  `X-Forwarded-For` forjado pelo cliente não altera o resultado.
- **`deploy/nginx/update-cloudflare-realip.sh`** — faz o nginx do host resolver o
  IP real via `CF-Connecting-IP`, restrito às faixas publicadas pela Cloudflare.
  Sem isto o `access.log` só continha IPs `104.x`/`172.x` do edge da CDN.
- **`deploy.sh`** — arquiva `docker logs` do slot antigo em
  `/var/www/yatsunami/logs/` antes de o remover, e limita o log do contentor a
  50 MB × 5 ficheiros.
