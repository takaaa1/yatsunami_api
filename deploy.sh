#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/var/www/yatsunami/api}"
BRANCH="${BRANCH:-${DEPLOY_BRANCH:-main}}"
SKIP_PRUNE="${SKIP_PRUNE:-false}"
API_PROXY_NAME="${API_PROXY_NAME:-yatsunami_api_proxy}"
API_SLOT_A_NAME="${API_SLOT_A_NAME:-yatsunami_api_a}"
API_SLOT_B_NAME="${API_SLOT_B_NAME:-yatsunami_api_b}"
LEGACY_PM2_APP="${LEGACY_PM2_APP:-yatsunami-api}"
PM2_HOME_VAR="${PM2_HOME:-/var/www/yatsunami/.pm2}"
PM2_SUDO_USER="${PM2_SUDO_USER:-yatsunami}"
API_PUBLIC_PORT="${API_PUBLIC_PORT:-3070}"
API_PORT_A="${API_PORT_A:-3071}"
API_PORT_B="${API_PORT_B:-3072}"
API_HEALTH_MAX_SEC="${API_HEALTH_MAX_SEC:-120}"
PROXY_STABILITY_CONSECUTIVE="${PROXY_STABILITY_CONSECUTIVE:-5}"
DEPLOY_STATE_FILE="${DEPLOY_STATE_FILE:-.deploy-active-slot}"
NGINX_DIR="${NGINX_DIR:-deploy/nginx}"
POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-5432}"
DB_WAIT_MAX_SEC="${DB_WAIT_MAX_SEC:-60}"
UPLOADS_HOST_PATH="${UPLOADS_HOST_PATH:-/var/www/yatsunami/uploads}"
IMAGE_NAME="${IMAGE_NAME:-yatsunami_api:latest}"

log() { echo "[$(date -Iseconds)] $*"; }

DOCKER_ENV_FILE=""

read_env_var() {
  local key="$1" line val
  [ -f ./.env ] || return 1
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" ./.env 2>/dev/null | head -1) || return 1
  val="${line#*=}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  val="${val//$'\r'/}"
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

validate_db_url() {
  local url="$1" label="$2"
  case "$url" in
    postgres://*|postgresql://*) return 0 ;;
    *)
      log "ERRO: ${label} inválida (esquema postgres/postgresql). Revise o .env — não use aspas mal fechadas nem variáveis vazias."
      exit 1
      ;;
  esac
}

preflight_db_env() {
  local db_url direct_url
  [ -f ./.env ] || {
    log "ERRO: .env não encontrado em ${REPO_DIR}"
    exit 1
  }
  db_url=$(read_env_var DATABASE_URL) || {
    log "ERRO: DATABASE_URL em falta no .env"
    exit 1
  }
  validate_db_url "$db_url" "DATABASE_URL"
  direct_url=$(read_env_var DIRECT_URL || true)
  if [ -z "$direct_url" ]; then
    log "AVISO: DIRECT_URL em falta — Prisma usa o mesmo valor que DATABASE_URL."
    direct_url="$db_url"
  fi
  validate_db_url "$direct_url" "DIRECT_URL"
}

prepare_docker_env_file() {
  local db_url direct_url
  if [ -n "$DOCKER_ENV_FILE" ] && [ -f "$DOCKER_ENV_FILE" ]; then
    return 0
  fi
  preflight_db_env
  db_url=$(read_env_var DATABASE_URL)
  direct_url=$(read_env_var DIRECT_URL || true)
  [ -z "$direct_url" ] && direct_url="$db_url"
  DOCKER_ENV_FILE=$(mktemp)
  chmod 600 "$DOCKER_ENV_FILE"
  grep -vE '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|DIRECT_URL)=' ./.env >"$DOCKER_ENV_FILE" || true
  printf 'DATABASE_URL=%s\n' "$db_url" >>"$DOCKER_ENV_FILE"
  printf 'DIRECT_URL=%s\n' "$direct_url" >>"$DOCKER_ENV_FILE"
  grep -qE '^[[:space:]]*(export[[:space:]]+)?RUNTIME_MODE=' "$DOCKER_ENV_FILE" || printf 'RUNTIME_MODE=long-running\n' >>"$DOCKER_ENV_FILE"
  grep -qE '^[[:space:]]*(export[[:space:]]+)?CRON_ENABLED=' "$DOCKER_ENV_FILE" || printf 'CRON_ENABLED=true\n' >>"$DOCKER_ENV_FILE"
}

cleanup_docker_env_file() {
  if [ -n "$DOCKER_ENV_FILE" ] && [ -f "$DOCKER_ENV_FILE" ]; then
    rm -f "$DOCKER_ENV_FILE"
    DOCKER_ENV_FILE=""
  fi
}

postgres_pg_user() {
  if [ -f ./.env ]; then
    local u
    u=$(grep -E '^POSTGRES_USER=' ./.env | head -1 | sed 's/^POSTGRES_USER=//' | tr -d "\"'")
    if [ -n "$u" ]; then
      echo "$u"
      return
    fi
  fi
  echo "yatsunami_db_user"
}

postgres_ready_host() {
  docker run --rm --network host postgres:16-alpine \
    pg_isready -h 127.0.0.1 -p "$POSTGRES_HOST_PORT" -U "$(postgres_pg_user)" -q 2>/dev/null
}

wait_for_postgres() {
  local elapsed=0
  log "Aguardando Postgres em 127.0.0.1:${POSTGRES_HOST_PORT} (até ${DB_WAIT_MAX_SEC}s)..."
  while [ "$elapsed" -lt "$DB_WAIT_MAX_SEC" ]; do
    if postgres_ready_host; then
      log "Postgres pronto (${elapsed}s)."
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  log "ERRO: Postgres não ficou pronto em ${DB_WAIT_MAX_SEC}s."
  exit 1
}

run_api_job() {
  local label="$1"
  shift
  prepare_docker_env_file
  log "${label} (--network host)..."
  docker run --rm \
    --network host \
    --env-file "$DOCKER_ENV_FILE" \
    "$IMAGE_NAME" \
    "$@"
}

active_slot() {
  local slot
  slot=$(cat "$DEPLOY_STATE_FILE" 2>/dev/null || true)
  if [ "$slot" = "a" ] || [ "$slot" = "b" ]; then
    echo "$slot"
    return
  fi
  echo "a"
}

standby_slot() {
  if [ "$(active_slot)" = "a" ]; then echo "b"; else echo "a"; fi
}

slot_port() {
  if [ "$1" = "a" ]; then echo "$API_PORT_A"; else echo "$API_PORT_B"; fi
}

slot_container() {
  if [ "$1" = "a" ]; then echo "$API_SLOT_A_NAME"; else echo "$API_SLOT_B_NAME"; fi
}

active_upstream_inc_path() {
  echo "${REPO_DIR}/${NGINX_DIR}/runtime/active-upstream.inc"
}

active_backend_inc_path() {
  echo "${REPO_DIR}/${NGINX_DIR}/runtime/active-backend.inc"
}

write_active_backend_inc() {
  local primary_port="$1"
  local backup_port="${2:-}"
  local upstream_inc backend_inc runtime_dir
  upstream_inc=$(active_upstream_inc_path)
  backend_inc=$(active_backend_inc_path)
  runtime_dir="$(dirname "$upstream_inc")"
  mkdir -p "$runtime_dir"
  {
    echo "upstream yatsunami_api_backend {"
    echo "  server 127.0.0.1:${primary_port} max_fails=2 fail_timeout=5s;"
    if [ -n "$backup_port" ]; then
      echo "  server 127.0.0.1:${backup_port} backup;"
    fi
    echo "}"
  } >"$upstream_inc"
  cat >"$backend_inc" <<'EOF'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
proxy_pass http://yatsunami_api_backend;
EOF
}

proxy_uses_runtime_mount() {
  docker inspect "$API_PROXY_NAME" --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null \
    | grep -q '/etc/nginx/runtime'
}

verify_proxy_primary_port() {
  local expected_port="$1"
  local upstream_inc
  upstream_inc=$(active_upstream_inc_path)
  if [ ! -f "$upstream_inc" ]; then
    log "ERRO: ${upstream_inc} não existe no host."
    return 1
  fi
  if ! grep -q "127.0.0.1:${expected_port}" "$upstream_inc"; then
    log "ERRO: ${upstream_inc} no host não referencia :${expected_port}."
    cat "$upstream_inc" 2>/dev/null || true
    return 1
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$API_PROXY_NAME"; then
    log "ERRO: proxy ${API_PROXY_NAME} não está em execução."
    return 1
  fi
  if ! proxy_uses_runtime_mount; then
    log "AVISO: proxy com mount antigo — será recriado."
    return 1
  fi
  if docker exec "$API_PROXY_NAME" grep -q "127.0.0.1:${expected_port}" \
    /etc/nginx/runtime/active-upstream.inc 2>/dev/null; then
    return 0
  fi
  log "ERRO: active-upstream.inc no proxy não referencia :${expected_port}."
  return 1
}

wait_for_proxy_container_running() {
  local elapsed=0
  while [ "$elapsed" -lt 30 ]; do
    if docker ps --format '{{.Names}} {{.Status}}' \
      | grep -q "^${API_PROXY_NAME} Up"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

start_api_proxy_container() {
  local backend_port="$1"
  local runtime_dir="${REPO_DIR}/${NGINX_DIR}/runtime"
  mkdir -p "$runtime_dir"
  docker rm -f "$API_PROXY_NAME" 2>/dev/null || true
  log "Proxy Nginx :${API_PUBLIC_PORT} → slot :${backend_port}..."
  docker run -d \
    --name "$API_PROXY_NAME" \
    --network host \
    -v "${REPO_DIR}/${NGINX_DIR}/proxy.conf:/etc/nginx/nginx.conf:ro" \
    -v "${runtime_dir}:/etc/nginx/runtime:ro" \
    --restart unless-stopped \
    nginx:alpine
  if ! wait_for_proxy_container_running; then
    log "ERRO: proxy ${API_PROXY_NAME} não ficou Up."
    timeout 10 docker logs "$API_PROXY_NAME" --tail 40 </dev/null 2>/dev/null || true
    exit 1
  fi
  docker exec "$API_PROXY_NAME" nginx -t
}

api_http_code() {
  local port="$1"
  local path="${2:-/api}"
  local raw
  raw=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 \
    "http://127.0.0.1:${port}${path}" 2>/dev/null || true)
  echo "$raw" | tr -d '\r\n' | grep -oE '[0-9]{3}' | tail -1
}

api_health_ok() {
  local code="$1"
  [ -n "$code" ] && [ "${#code}" -eq 3 ] && [ "$code" != "000" ] || return 1
  case "$code" in
    2?? | 3?? | 4??) return 0 ;;
    *) return 1 ;;
  esac
}

wait_for_api_health() {
  local port="$1"
  local elapsed=0
  local code
  log "Aguardando API em 127.0.0.1:${port}/api (até ${API_HEALTH_MAX_SEC}s)..."
  while [ "$elapsed" -lt "$API_HEALTH_MAX_SEC" ]; do
    code=$(api_http_code "$port" "/api")
    if api_health_ok "$code"; then
      log "API pronta em :${port} (HTTP ${code}, ${elapsed}s)."
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  log "ERRO: API não respondeu em 127.0.0.1:${port}."
  return 1
}

wait_for_proxy_health() {
  local elapsed=0
  local code
  log "Aguardando proxy em :${API_PUBLIC_PORT}/api (até ${API_HEALTH_MAX_SEC}s)..."
  while [ "$elapsed" -lt "$API_HEALTH_MAX_SEC" ]; do
    code=$(api_http_code "$API_PUBLIC_PORT" "/api")
    if api_health_ok "$code"; then
      log "Proxy OK (HTTP ${code}, ${elapsed}s)."
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  log "ERRO: proxy/API não responde em :${API_PUBLIC_PORT} (último HTTP ${code:-?})."
  timeout 10 docker logs "$API_PROXY_NAME" --tail 20 </dev/null 2>/dev/null || true
  return 1
}

wait_for_proxy_stability() {
  local expected_port="$1"
  local streak=0
  local attempt=0
  local max_attempts=$((PROXY_STABILITY_CONSECUTIVE * 4))
  local code
  log "Estabilidade do proxy (${PROXY_STABILITY_CONSECUTIVE} OK consecutivos)..."
  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))
    if ! verify_proxy_primary_port "$expected_port"; then
      return 1
    fi
    code=$(api_http_code "$API_PUBLIC_PORT" "/api")
    if api_health_ok "$code"; then
      streak=$((streak + 1))
      if [ "$streak" -ge "$PROXY_STABILITY_CONSECUTIVE" ]; then
        log "Proxy estável (${streak} OK)."
        return 0
      fi
    else
      streak=0
    fi
    sleep 2
  done
  return 1
}

reload_api_proxy() {
  if docker ps --format '{{.Names}}' | grep -qx "$API_PROXY_NAME"; then
    docker exec "$API_PROXY_NAME" nginx -t
    docker exec "$API_PROXY_NAME" nginx -s reload
  fi
}

ensure_api_proxy() {
  local backend_port="$1"
  local backup_port="${2:-}"
  write_active_backend_inc "$backend_port" "$backup_port"
  if docker ps --format '{{.Names}}' | grep -qx "$API_PROXY_NAME"; then
    if proxy_uses_runtime_mount; then
      reload_api_proxy
      return 0
    fi
    start_api_proxy_container "$backend_port"
    return 0
  fi
  start_api_proxy_container "$backend_port"
}

run_api_slot() {
  local slot="$1"
  local port name
  port=$(slot_port "$slot")
  name=$(slot_container "$slot")
  docker rm -f "$name" 2>/dev/null || true
  log "A iniciar slot ${slot} (${name}) na porta ${port}..."
  prepare_docker_env_file
  docker run -d \
    --name "$name" \
    --network host \
    --env-file "$DOCKER_ENV_FILE" \
    -e "PORT=${port}" \
    -v "${UPLOADS_HOST_PATH}:${UPLOADS_HOST_PATH}" \
    -e "UPLOADS_PATH=${UPLOADS_HOST_PATH}" \
    --restart unless-stopped \
    "$IMAGE_NAME" \
    node dist/main.js
}

pm2_run() {
  if [ -n "$PM2_SUDO_USER" ]; then
    sudo -u "$PM2_SUDO_USER" env PM2_HOME="$PM2_HOME_VAR" "$@"
  else
    env PM2_HOME="$PM2_HOME_VAR" "$@"
  fi
}

rollback_blue_green() {
  local active="$1"
  local active_port="$2"
  local standby="$3"
  local active_name standby_name
  active_name=$(slot_container "$active")
  standby_name=$(slot_container "$standby")
  log "ROLLBACK: a repor slot ${active} (:${active_port})..."
  if ! docker ps --format '{{.Names}}' | grep -qx "$active_name"; then
    run_api_slot "$active"
    wait_for_api_health "$active_port" || true
  fi
  write_active_backend_inc "$active_port"
  ensure_api_proxy "$active_port"
  reload_api_proxy
  docker rm -f "$standby_name" 2>/dev/null || true
  echo "$active" >"$DEPLOY_STATE_FILE"
}

migrate_legacy_pm2() {
  if docker ps --format '{{.Names}}' | grep -qx "$API_PROXY_NAME"; then
    return 0
  fi
  if ! pm2_run pm2 describe "$LEGACY_PM2_APP" >/dev/null 2>&1; then
    return 0
  fi
  log "Migração única: PM2 ${LEGACY_PM2_APP} → blue/green Docker..."
  pm2_run pm2 delete "$LEGACY_PM2_APP" 2>/dev/null || true
  pm2_run pm2 save 2>/dev/null || true
  run_api_slot "a"
  wait_for_api_health "$API_PORT_A"
  ensure_api_proxy "$API_PORT_A"
  wait_for_proxy_health
  echo "a" >"$DEPLOY_STATE_FILE"
  log "Migração PM2 concluída; tráfego em :${API_PUBLIC_PORT} → slot a (:${API_PORT_A})."
}

deploy_api_blue_green() {
  log "Deploy blue/green (proxy :${API_PUBLIC_PORT}, slots :${API_PORT_A}/:${API_PORT_B})..."
  migrate_legacy_pm2

  local active standby active_port standby_port active_name standby_name
  local active_was_running=0
  active=$(active_slot)
  standby=$(standby_slot)
  active_port=$(slot_port "$active")
  standby_port=$(slot_port "$standby")
  active_name=$(slot_container "$active")
  standby_name=$(slot_container "$standby")

  if docker ps --format '{{.Names}}' | grep -qx "$active_name"; then
    active_was_running=1
  fi

  if ! docker ps --format '{{.Names}}' | grep -qx "$API_PROXY_NAME"; then
    if [ "$active_was_running" = "1" ]; then
      ensure_api_proxy "$active_port"
      wait_for_proxy_health || true
    fi
  fi

  log "Ativo=${active} (:${active_port}); a subir standby=${standby} (:${standby_port})..."
  run_api_slot "$standby"
  if ! wait_for_api_health "$standby_port"; then
    timeout 10 docker logs "$standby_name" --tail 50 </dev/null 2>/dev/null || true
    docker rm -f "$standby_name" 2>/dev/null || true
    exit 1
  fi

  if [ "$active_was_running" = "1" ]; then
    ensure_api_proxy "$standby_port" "$active_port"
  else
    ensure_api_proxy "$standby_port"
  fi
  reload_api_proxy
  if ! verify_proxy_primary_port "$standby_port"; then
    rollback_blue_green "$active" "$active_port" "$standby"
    exit 1
  fi
  if ! wait_for_proxy_health; then
    rollback_blue_green "$active" "$active_port" "$standby"
    exit 1
  fi
  if ! wait_for_proxy_stability "$standby_port"; then
    rollback_blue_green "$active" "$active_port" "$standby"
    exit 1
  fi

  write_active_backend_inc "$standby_port"
  reload_api_proxy
  verify_proxy_primary_port "$standby_port" || {
    rollback_blue_green "$active" "$active_port" "$standby"
    exit 1
  }

  if [ "$active_was_running" = "1" ]; then
    log "A remover slot antigo ${active_name}..."
    docker rm -f "$active_name" 2>/dev/null || true
  fi

  echo "$standby" >"$DEPLOY_STATE_FILE"
  log "Blue/green OK — :${API_PUBLIC_PORT} → slot ${standby} (:${standby_port})."
}

cd "$REPO_DIR"
trap cleanup_docker_env_file EXIT

git fetch origin "$BRANCH" || git fetch origin

if ! git rev-parse "origin/$BRANCH" >/dev/null 2>&1; then
  log "ERRO: origin/$BRANCH não existe."
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  if [ "${FORCE_DEPLOY:-}" = "true" ]; then
    log "FORCE_DEPLOY=true — deploy sem commits novos."
  elif [ -t 0 ]; then
    printf 'Sem commits novos. Executar deploy mesmo assim? [s/N] '
    read -r REPLY
    case "${REPLY,,}" in
      s|sim|y|yes) ;;
      *) log "Cancelado."; exit 0 ;;
    esac
  else
    log "Sem alterações no Git (${LOCAL:0:8}). Use FORCE_DEPLOY=true para forçar."
    exit 0
  fi
else
  log "Atualização Git: ${LOCAL:0:8} -> ${REMOTE:0:8}"
  git reset --hard "origin/$BRANCH"
fi

log "1/4: docker build ${IMAGE_NAME}..."
docker build -t "$IMAGE_NAME" .

preflight_db_env
wait_for_postgres

log "2/4: prisma migrate deploy..."
run_api_job "migrate deploy" npx prisma migrate deploy

log "3/4: blue/green API..."
deploy_api_blue_green

if [ "$SKIP_PRUNE" != "true" ]; then
  log "4/4: Limpando imagens antigas órfãs e lixo do BuildKit..."
  docker image prune -a -f
  docker builder prune -f
fi

log "Estado:"
docker ps --filter "name=yatsunami_api" --format 'table {{.Names}}\t{{.Status}}'
log "Teste: curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${API_PUBLIC_PORT}/api"
log "Concluído."
