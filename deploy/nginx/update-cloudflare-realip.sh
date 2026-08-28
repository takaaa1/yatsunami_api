#!/usr/bin/env bash
# Gera /etc/nginx/conf.d/cloudflare-realip.conf a partir das faixas publicadas
# pela Cloudflare, para que $remote_addr no nginx do host seja o IP real do
# cliente e não o do edge da CDN.
#
# Sem isto, todo o access.log regista IPs 104.x/172.x da Cloudflare — foi o que
# impediu identificar a origem da sessão que criou a venda 312 (2026-08-23).
#
# Correr como root:  sudo bash deploy/nginx/update-cloudflare-realip.sh
# Convém repetir periodicamente (as faixas mudam) — ver cron no fim do ficheiro.
set -euo pipefail

OUT="${OUT:-/etc/nginx/conf.d/cloudflare-realip.conf}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

fetch() {
  curl -fsS --max-time 20 "$1"
}

{
  echo "# Gerado por update-cloudflare-realip.sh em $(date -Iseconds). Não editar à mão."
  for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
    fetch "$url" | while read -r cidr; do
      [ -n "$cidr" ] && echo "set_real_ip_from ${cidr};"
    done
  done
  # A CF define este header com o IP de origem e sobrepõe-o a qualquer valor que
  # o cliente envie; só é aceite porque as faixas acima limitam quem pode falar.
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive on;"
} >"$TMP"

if ! grep -q '^set_real_ip_from' "$TMP"; then
  echo "ERRO: não foi possível obter as faixas da Cloudflare; $OUT não foi alterado." >&2
  exit 1
fi

install -m 0644 "$TMP" "$OUT"
echo "OK: $OUT actualizado ($(grep -c '^set_real_ip_from' "$OUT") faixas)."

# RELOAD=0 permite validar a geração sem tocar no nginx (ex.: em CI ou dry-run).
if [ "${RELOAD:-1}" = "1" ]; then
  nginx -t
  systemctl reload nginx
  echo "OK: nginx recarregado."
fi

# Para manter actualizado:
#   echo '0 4 * * 1 root bash /var/www/yatsunami/api/deploy/nginx/update-cloudflare-realip.sh >/dev/null 2>&1' \
#     | sudo tee /etc/cron.d/cloudflare-realip
