#!/usr/bin/env bash
# Cron / deploy automático — delega para blue/green em deploy.sh
#
# Uso típico (cron):
#   */5 * * * * /var/www/yatsunami/api/scripts/vps-deploy.sh >> /var/log/yatsunami/deploy.log 2>&1
#
# Variáveis: REPO_DIR, DEPLOY_BRANCH, FORCE_DEPLOY, SKIP_PRUNE (ver deploy.sh)

set -euo pipefail

# REPO_DIR (documentado acima) tem precedência; VPS_REPO_DIR fica por compatibilidade.
REPO_DIR="${REPO_DIR:-${VPS_REPO_DIR:-/var/www/yatsunami/api}}"

if [ ! -x "${REPO_DIR}/deploy.sh" ]; then
  echo "[$(date -Iseconds)] ERRO: ${REPO_DIR}/deploy.sh não encontrado. Faça git pull."
  exit 1
fi

export REPO_DIR
export DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
cd "$REPO_DIR"
exec ./deploy.sh
