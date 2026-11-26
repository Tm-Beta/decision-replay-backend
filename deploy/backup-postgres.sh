#!/usr/bin/env bash
# Daily gzipped PostgreSQL backup script with 14-day retention
set -euo pipefail

BACKUP_DIR="/opt/soichose/backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y-%m-%d_%H%M)"
OUT_FILE="$BACKUP_DIR/soichose-pg-$STAMP.sql.gz"

docker exec soichose-postgres pg_dump -U "${POSTGRES_USER:-soichose}" "${POSTGRES_DB:-soichose}" \
  | gzip -9 > "$OUT_FILE"
chmod 600 "$OUT_FILE"

# Keep last 14 days
find "$BACKUP_DIR" -name "soichose-pg-*.sql.gz" -mtime +14 -delete
echo "[Backup] Saved $OUT_FILE"
