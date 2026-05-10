#!/usr/bin/env bash
# Deploy na VPS: atualiza o código e reinicia a API.
#
# Uso típico (cron):
#   */5 * * * * PM2_SUDO_USER=yatsunami PM2_HOME=/var/www/yatsunami/.pm2 /var/www/yatsunami/api/scripts/vps-deploy.sh >> /var/log/yatsunami/deploy.log 2>&1
#
# Variáveis opcionais:
#   VPS_REPO_DIR   — pasta do clone (default: /var/www/yatsunami/api)
#   DEPLOY_BRANCH  — branch (default: main)
#   PM2_APP_NAME   — nome no PM2 (default: yatsunami-api)
#   PM2_HOME       — PM2_HOME (default: /var/www/yatsunami/.pm2)
#   PM2_SUDO_USER  — se definido, executa pm2 como esse utilizador (ex.: yatsunami)
#   SKIP_MIGRATIONS — se "true", pula o prisma migrate deploy

set -euo pipefail

REPO_DIR="${VPS_REPO_DIR:-/var/www/yatsunami/api}"
BRANCH="${DEPLOY_BRANCH:-main}"
PM2_NAME="${PM2_APP_NAME:-yatsunami-api}"
PM2_HOME_VAR="${PM2_HOME:-/var/www/yatsunami/.pm2}"
PM2_SUDO_USER="${PM2_SUDO_USER:-}"
SKIP_MIGRATIONS="${SKIP_MIGRATIONS:-false}"

log() { echo "[$(date -Iseconds)] $*"; }

cd "$REPO_DIR"

git fetch origin "$BRANCH" || git fetch origin

if ! git rev-parse "origin/$BRANCH" >/dev/null 2>&1; then
  log "ERRO: origin/$BRANCH não existe após fetch."
  exit 1
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Sem alterações (HEAD = origin/$BRANCH = ${LOCAL:0:8})."
  exit 0
fi

log "Deploy: ${LOCAL:0:8} -> ${REMOTE:0:8}"
git reset --hard "origin/$BRANCH"

log "npm ci…"
npm ci

log "prisma generate…"
npx prisma generate

log "npm run build…"
npm run build

if [ "$SKIP_MIGRATIONS" != "true" ]; then
  log "prisma migrate deploy…"
  npx prisma migrate deploy
else
  log "Migrations ignoradas (SKIP_MIGRATIONS=true)."
fi

restart_pm2() {
  if [ -n "$PM2_SUDO_USER" ]; then
    sudo -u "$PM2_SUDO_USER" env PM2_HOME="$PM2_HOME_VAR" pm2 restart "$PM2_NAME"
  else
    env PM2_HOME="$PM2_HOME_VAR" pm2 restart "$PM2_NAME"
  fi
}

log "pm2 restart $PM2_NAME…"
restart_pm2

log "Concluído."
