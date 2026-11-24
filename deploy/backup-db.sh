#!/usr/bin/env bash
# Runs ON THE HOST in the deploy directory. Writes a compressed pg_dump of the previsit database
# to ./backups/previsit-<timestamp>.sql.gz (directory 700, file 600). Read-only for the database.
# Run it before every upgrade: migrations only move forward, so a dump is the real way back.
#   ./backup-db.sh
# Backups are never deleted by this script; remove old ones by hand when the disk gets tight.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=remote-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/remote-common.sh"

detect_docker
check_env_file
[ -n "$(dc ps -q db 2>/dev/null | head -n1)" ] || die "the db container of project $PROJECT is not running"

umask 077
mkdir -p "$DIR/backups"
chmod 700 "$DIR/backups"
out="$DIR/backups/previsit-$(date +%Y%m%d-%H%M%S).sql.gz"
trap 'rm -f "$out"' ERR

# The database name and user come from the container's own environment, so no secret is passed here.
# The single quotes are intentional: the shell INSIDE the container expands the variables.
# shellcheck disable=SC2016
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' | gzip -c > "$out"
gzip -t "$out"
[ "$(stat -c %s "$out")" -gt 200 ] || die "backup file is suspiciously small"
trap - ERR
log "backup written: $out ($(du -h "$out" | cut -f1))"
