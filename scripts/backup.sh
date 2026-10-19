#!/usr/bin/env bash
# Back up the database and uploaded files into ./backups (on the VPS).
#
#   bash scripts/backup.sh
#
# Writes backups/db-<timestamp>.dump (pg_dump custom format, verified readable)
# and backups/uploads-<timestamp>.tar.gz. Deletes backups in ./backups older
# than BACKUP_RETENTION_DAYS (from .env, default 14) — copy them off the server.
set -euo pipefail
export MSYS_NO_PATHCONV=1  # no-op on Linux; stops Git Bash rewriting /app/... paths when run locally on Windows
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups

die() { echo "ERROR: $*" >&2; exit 1; }
ts=$(date +%Y%m%d-%H%M%S)
db="backups/db-$ts.dump"
up="backups/uploads-$ts.tar.gz"
trap 'rm -f "$db.partial" "$up.partial"' EXIT

[ -n "$(docker compose ps -q --status running postgres)" ] || die "postgres is not running (docker compose up -d postgres)."

echo "==> Dumping database to $db"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$db.partial"
docker compose exec -T postgres pg_restore -l < "$db.partial" > /dev/null || die "the dump is not readable"
mv "$db.partial" "$db"

echo "==> Archiving uploads to $up"
if [ -n "$(docker compose ps -q --status running backend)" ]; then
  docker compose exec -T backend tar czf - -C /app/uploads . > "$up.partial"
else
  docker compose run --rm --no-deps -T --entrypoint tar backend czf - -C /app/uploads . > "$up.partial"
fi
gzip -t "$up.partial" || die "the uploads archive is corrupt"
mv "$up.partial" "$up"

days=$(grep -E '^BACKUP_RETENTION_DAYS=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r' || true)
[[ "$days" =~ ^[0-9]+$ ]] && [ "$days" -ge 1 ] || days=14
find backups -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +"$days" -delete

ls -lh "$db" "$up"
echo "==> Backup complete. Copy it off the server (DEPLOYMENT.md §8)."
