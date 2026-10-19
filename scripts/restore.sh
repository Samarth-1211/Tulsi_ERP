#!/usr/bin/env bash
# DESTRUCTIVE: replace the database (and optionally the uploaded files) with a backup.
#
#   bash scripts/restore.sh backups/db-YYYYMMDD-HHMMSS.dump [backups/uploads-YYYYMMDD-HHMMSS.tar.gz]
#
# - Asks you to type RESTORE before changing anything.
# - Takes a safety backup of the current state first (scripts/backup.sh).
# - Stops the backend, restores, then starts it again and waits until healthy.
# Restore with the application revision that matches the backup (deploy-history.log):
# the dump carries its own schema and migration history.
set -euo pipefail
export MSYS_NO_PATHCONV=1  # no-op on Linux; stops Git Bash rewriting /app/... paths when run locally on Windows
cd "$(dirname "$0")/.."

die() { echo "ERROR: $*" >&2; exit 1; }
db=${1:-}
up=${2:-}
[ -n "$db" ] || die "usage: bash scripts/restore.sh <db-dump> [uploads-tar.gz]"
[ -f "$db" ] || die "$db not found"
[ -z "$up" ] || [ -f "$up" ] || die "$up not found"

docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -l < "$db" > /dev/null || die "$db is not a pg_dump custom-format archive"
[ -z "$up" ] || gzip -t "$up" || die "$up is not a valid .tar.gz"

echo "This REPLACES the current database${up:+ and ALL uploaded files} with:"
echo "  $db${up:+
  $up}"
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || die "aborted, nothing changed"

echo "==> Safety backup of the current state"
bash scripts/backup.sh

echo "==> Stopping backend"
docker compose stop backend

echo "==> Restoring database"
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error' \
  < "$db"

if [ -n "$up" ]; then
  echo "==> Restoring uploads"
  docker compose run --rm --no-deps -T --entrypoint sh backend \
    -c 'find /app/uploads -mindepth 1 -delete && tar xzf - -C /app/uploads' < "$up"
fi

echo "==> Starting backend"
docker compose up -d --wait --wait-timeout 300 backend
docker compose ps
echo "==> Restore complete."
