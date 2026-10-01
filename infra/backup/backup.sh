#!/bin/sh
# Every day at BACKUP_AT_UTC (HH:MM, default 11:30 UTC, after the 03:30 Vancouver data build):
#   <BACKUP_REMOTE>/db/transitopia-<date>.dump   full backup (custom format), kept BACKUP_KEEP_DAYS
#   <BACKUP_REMOTE>/snapshots/db-latest.dump     snapshot for developers (npm run snapshot:pull):
#       no users or sessions, and no raw positions, AIS fixes or request log (those come as hourly
#       files for the dates asked for)
# Restore: pg_restore --clean --if-exists -d "$DATABASE_URL" transitopia-<date>.dump
# Run once now: docker compose run --rm backup /usr/local/bin/backup.sh --now (exits 1 on failure)
set -eu

: "${DATABASE_URL:?}" "${BACKUP_REMOTE:?}"
AT="${BACKUP_AT_UTC:-11:30}"
KEEP="${BACKUP_KEEP_DAYS:-30}"

# Recorded in job_runs, so the server's /healthz notices when backups stop.
record() {
  psql -q -d "$DATABASE_URL" -v status="$1" -v key="$2" -v err="${3:-}" <<'SQL'
insert into job_runs (job, key, status, started_at, finished_at, error)
values ('backup', :'key', :'status', now(), now(), nullif(:'err', ''))
on conflict (job, key) do update set status = excluded.status, finished_at = now(), error = excluded.error;
SQL
}

# Every step is checked explicitly: `set -e` doesn't apply inside a function called from `if` or
# `&&`, so without these a failed upload still reported "done".
backup() {
  day=$(date -u +%Y-%m-%d)
  tmp=$(mktemp -d) || return 1
  echo "[backup] $day: dumping"
  pg_dump -Fc -d "$DATABASE_URL" -f "$tmp/full.dump" || return 1
  rclone copyto "$tmp/full.dump" "$BACKUP_REMOTE/db/transitopia-$day.dump" --s3-no-check-bucket || return 1
  rclone delete "$BACKUP_REMOTE/db" --min-age "${KEEP}d" || return 1
  pg_dump -Fc -d "$DATABASE_URL" -f "$tmp/snapshot.dump" \
    --exclude-table-data=users --exclude-table-data=sessions \
    --exclude-table-data='rt_positions*' --exclude-table-data='ais_fixes*' \
    --exclude-table-data=upstream_requests --exclude-table-data=service_leader || return 1
  rclone copyto "$tmp/snapshot.dump" "$BACKUP_REMOTE/snapshots/db-latest.dump" --s3-no-check-bucket || return 1
  rm -rf "$tmp"
  size=$(rclone size "$BACKUP_REMOTE/db" --json) || return 1
  echo "[backup] $day: done ($(echo "$size" | tr -d '\n'))"
}

run() {
  day=$(date -u +%Y-%m-%d)
  if backup; then
    record done "$day"
  else
    echo "[backup] $day: FAILED"
    record failed "$day" "see the backup container's log" || true
    return 1
  fi
}

if [ "${1:-}" = "--now" ]; then
  run
  exit $?
fi

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today $AT" +%s)
  [ "$next" -le "$now" ] && next=$(date -u -d "tomorrow $AT" +%s)
  echo "[backup] next backup at $(date -u -d "@$next")"
  sleep $((next - now))
  run || true
done
