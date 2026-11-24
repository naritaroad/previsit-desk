# shellcheck shell=bash
# Shared helpers for the scripts that run ON THE HOST (remote-up.sh, rollback.sh, host-preflight.sh).
# Sourced, not executed. Keep every docker call scoped to the previsit-desk compose project:
# the host also runs another project (grex) that must never be stopped, restarted or pruned.

PROJECT="previsit-desk"
IMAGE_NAME="previsit-desk"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$DIR/compose.prod.yaml"
ENV_FILE="$DIR/.env"
STATE_FILE="$DIR/.deploy-state"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Docker needs sudo on this host unless the user is in the docker group.
detect_docker() {
  if [ "$(id -u)" -eq 0 ] || docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
  else
    die "cannot reach the docker daemon (tried 'docker' and 'sudo -n docker')"
  fi
}

# Compose, always scoped: -p previsit-desk, our compose file, our env files.
# .deploy-state (IMAGE_TAG=...) is a second env file so a manual call behaves like the scripts.
dc() {
  local envs=(--env-file "$ENV_FILE")
  [ -f "$STATE_FILE" ] && envs+=(--env-file "$STATE_FILE")
  "${DOCKER[@]}" compose -p "$PROJECT" "${envs[@]}" -f "$COMPOSE_FILE" "$@"
}

# ---- .env handling: parsed, never sourced, values never printed ----
env_get() {
  local v
  v=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | sed -E "s/^[[:space:]]*$1=//" | tr -d '\r') || true
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

check_env_file() {
  [ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE (create it from .env.example, then: chmod 600 .env)"
  local mode
  mode=$(stat -c '%a' "$ENV_FILE")
  # Any group/other permission bit is refused: the file holds the DB password, API key and tunnel token.
  if [ $(( 8#$mode & 8#077 )) -ne 0 ]; then
    die ".env has mode $mode (group/other can read it). Run: chmod 600 $ENV_FILE"
  fi
  log ".env present, mode $mode"
}

# require_keys KEY...  -> every key must be non-empty and not the CHANGE_ME placeholder
require_keys() {
  local bad=0 k v
  for k in "$@"; do
    v=$(env_get "$k")
    if [ -z "$v" ] || [ "$v" = "CHANGE_ME" ]; then
      log "  missing or placeholder: $k"
      bad=1
    else
      log "  set: $k"
    fi
  done
  [ "$bad" -eq 0 ] || die "fix the variables above in .env (values are never printed)"
}

state_get() { grep -E "^$1=" "$STATE_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r' || true; }

state_write() { # state_write CURRENT PREVIOUS
  local tmp
  tmp=$(mktemp "$DIR/.deploy-state.XXXXXX")
  { printf 'IMAGE_TAG=%s\n' "$1"; printf 'PREVIOUS_IMAGE_TAG=%s\n' "$2"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

image_exists() { "${DOCKER[@]}" image inspect "$IMAGE_NAME:$1" >/dev/null 2>&1; }

# wait_healthy SERVICE SECONDS
wait_healthy() {
  local svc=$1 secs=$2 cid st end
  end=$((SECONDS + secs))
  while [ "$SECONDS" -lt "$end" ]; do
    cid=$(dc ps -q "$svc" 2>/dev/null | head -n1 || true)
    st=""
    if [ -n "$cid" ]; then
      st=$("${DOCKER[@]}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)
    fi
    case "$st" in
      healthy) log "$svc: healthy"; return 0 ;;
      unhealthy) log "$svc: UNHEALTHY"; return 1 ;;
    esac
    sleep 3
  done
  log "$svc: not healthy after ${secs}s (last status: ${st:-no container})"
  return 1
}

# Containers that are NOT part of our project (for example grex): print name, status, StartedAt.
# Read-only. Called before and after a change so the output proves they were left alone.
neighbors() {
  local id
  "${DOCKER[@]}" ps -q 2>/dev/null | while read -r id; do
    [ -n "$id" ] || continue
    "${DOCKER[@]}" inspect -f '{{if ne (index .Config.Labels "com.docker.compose.project") "'"$PROJECT"'"}}{{.Name}} | {{.State.Status}} | started {{.State.StartedAt}}{{end}}' "$id" 2>/dev/null || true
  done | grep -v '^$' | sort || true
}

port_in_use() { # port_in_use PORT -> 0 if something listens on it (host or docker-published)
  local p=$1
  if command -v ss >/dev/null 2>&1 && [ -n "$(ss -H -ltn "sport = :$p" 2>/dev/null)" ]; then return 0; fi
  if "${DOCKER[@]}" ps --format '{{.Ports}}' 2>/dev/null | grep -qE "(:|^)${p}->"; then return 0; fi
  return 1
}
