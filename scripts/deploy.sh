#!/usr/bin/env bash
# Build and (re)start the Tulsi ERP backend stack on the VPS. Safe to re-run.
#
#   bash scripts/deploy.sh                 back up (if running), git pull, rebuild, restart, verify
#   bash scripts/deploy.sh --no-pull       deploy the code that is already checked out (first deploy, rollback)
#   bash scripts/deploy.sh --skip-backup   skip the pre-deploy backup (not recommended)
#
# Never deletes volumes. Each run appends the deployed revision to deploy-history.log.
set -euo pipefail
export MSYS_NO_PATHCONV=1  # no-op on Linux; stops Git Bash rewriting /app/... paths when run locally on Windows
cd "$(dirname "$0")/.."

PULL=1
BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --skip-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '\r' || true; }
revision() { git rev-parse --short HEAD 2>/dev/null || echo unknown; }

# ---- Preflight -------------------------------------------------------------
command -v docker >/dev/null || die "docker is not installed (DEPLOYMENT.md §5)."
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed (DEPLOYMENT.md §5)."
[ -f .env ] || die ".env not found. Run: cp .env.production.example .env && chmod 600 .env, then fill it in."
grep -q $'\r' .env && die ".env has Windows line endings. Fix with: sed -i 's/\r\$//' .env"

for key in API_DOMAIN ACME_EMAIL CORS_ORIGINS POSTGRES_PASSWORD JWT_ACCESS_SECRET CREDENTIALS_ENCRYPTION_KEY \
           SUPERADMIN_EMAIL SUPERADMIN_PASSWORD SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM_EMAIL; do
  value=$(env_value "$key")
  [ -n "$value" ] || die "$key is missing or blank in .env"
  case "$value" in
    *replace-with*|*example.com*|your-*) die "$key in .env still holds the placeholder from .env.production.example" ;;
  esac
done
[[ $(env_value API_DOMAIN) =~ ^[A-Za-z0-9.-]+$ ]] || die "API_DOMAIN must be a bare host name (no https://, no slash)."
IFS=',' read -ra origins <<< "$(env_value CORS_ORIGINS)"
for origin in "${origins[@]}"; do
  origin=$(echo "$origin" | tr -d ' ')
  [[ "$origin" =~ ^https?://[^/]+$ ]] || die "CORS_ORIGINS entry '$origin' must be scheme + host only, e.g. https://erp.example.com (no trailing slash)."
done
[[ $(env_value POSTGRES_PASSWORD) =~ ^[A-Za-z0-9._~-]+$ ]] \
  || die "POSTGRES_PASSWORD may only contain A-Z a-z 0-9 . _ ~ - (it is embedded in a URL). Use: openssl rand -hex 24"
[[ $(env_value CREDENTIALS_ENCRYPTION_KEY) =~ ^[0-9a-fA-F]{64}$ ]] \
  || die "CREDENTIALS_ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32)."
jwt=$(env_value JWT_ACCESS_SECRET); [ "${#jwt}" -ge 32 ] || die "JWT_ACCESS_SECRET must be at least 32 characters."
sa=$(env_value SUPERADMIN_PASSWORD); [ "${#sa}" -ge 12 ] || die "SUPERADMIN_PASSWORD must be at least 12 characters."
blank=$(grep -nE '^[A-Z_]+=[[:space:]]*$' .env || true)
[ -z "$blank" ] || die "blank settings in .env override the app's defaults — comment them out instead:
$blank"

docker compose config --quiet || die "docker-compose.yml / .env did not validate (see above)."

# ---- Backup ----------------------------------------------------------------
if [ "$BACKUP" = 1 ] && [ -n "$(docker compose ps -q --status running postgres 2>/dev/null)" ]; then
  echo "==> Backing up before deploying"
  bash scripts/backup.sh
fi

# ---- Code ------------------------------------------------------------------
before=${TULSI_DEPLOY_PREVIOUS:-$(revision)}
if [ "$PULL" = 1 ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] \
    || die "the server checkout has uncommitted changes. Commit/stash them, or use --no-pull."
  echo "==> git pull"
  git pull --ff-only
  # This script may itself have changed: re-run the new version once.
  if [ -z "${TULSI_DEPLOY_REEXEC:-}" ] && [ "$before" != "$(revision)" ]; then
    export TULSI_DEPLOY_REEXEC=1 TULSI_DEPLOY_PREVIOUS="$before"
    exec bash scripts/deploy.sh --no-pull --skip-backup
  fi
fi
after=$(revision)

# ---- Build & start ---------------------------------------------------------
echo "==> Building the backend image"
docker compose build backend
echo "==> Starting services (migrations run when the backend starts)"
if ! docker compose up -d --remove-orphans --wait --wait-timeout 300; then
  docker compose ps
  echo "---- last backend logs ----"
  docker compose logs --tail=80 backend
  echo "$(date -Is) FAILED  backend=$after (previous: $before)" >> deploy-history.log
  die "services did not become healthy. Roll back: DEPLOYMENT.md §9."
fi
echo "$(date -Is) OK      backend=$after (previous: $before)" >> deploy-history.log

docker compose ps
api="https://$(env_value API_DOMAIN)/health"
if curl -fsS --max-time 15 "$api" >/dev/null 2>&1; then
  echo "==> $api is reachable over HTTPS. Deploy complete: backend=$after"
else
  echo "WARNING: containers are healthy but $api is not reachable yet."
  echo "         Check DNS, firewall (80/443) and: docker compose logs caddy"
fi
