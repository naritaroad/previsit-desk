#!/usr/bin/env bash
# Runs ON THE HOST in the deploy directory (next to compose.prod.yaml and .env).
# Validates .env, starts or updates the previsit-desk project, waits for health, prints status.
# Touches only containers of the compose project "previsit-desk".
#
#   ./remote-up.sh --check-only                 # validate everything, change nothing
#   ./remote-up.sh --tag 20261125-1530-gabc123  # deploy that image tag (default: tag in .deploy-state)
#   ./remote-up.sh --no-tunnel                  # db + api only (no cloudflared), for a first local check
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=remote-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/remote-common.sh"

TAG="${IMAGE_TAG:-}"
NO_TUNNEL=0
CHECK_ONLY=0
WAIT_SECS=120

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    --no-tunnel) NO_TUNNEL=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --wait) WAIT_SECS="${2:?--wait needs seconds}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
done

detect_docker
CURRENT=$(state_get IMAGE_TAG)
[ -n "$TAG" ] || TAG="$CURRENT"
[ -n "$TAG" ] || die "no image tag: pass --tag TAG (ship.ps1 prints it) or set IMAGE_TAG"
[[ "$TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || die "image tag has unexpected characters"

log "project=$PROJECT dir=$DIR image=$IMAGE_NAME:$TAG (current=${CURRENT:-none})"

# ---- 1. checks (nothing is changed here) ----
check_env_file
log "required variables:"
KEYS=(POSTGRES_PASSWORD CLINICIAN_USERNAME CLINICIAN_PASSWORD LLM_MODEL)
if [ "$(env_get LLM_MODEL)" != "mock" ]; then KEYS+=(GEMINI_API_KEY); fi
if [ "$NO_TUNNEL" -eq 0 ]; then KEYS+=(TUNNEL_TOKEN); fi
require_keys "${KEYS[@]}"

if [ "$(env_get COOKIE_SECURE)" = "false" ]; then
  die "COOKIE_SECURE=false in .env; behind the HTTPS tunnel it must be true (or unset)"
fi
HOST_PORT_VALUE="$(env_get HOST_PORT)"; HOST_PORT_VALUE="${HOST_PORT_VALUE:-18088}"
[[ "$HOST_PORT_VALUE" =~ ^[0-9]{4,5}$ ]] || die "HOST_PORT is not a port number"
if [ -z "$(dc ps -q api 2>/dev/null | head -n1)" ] && port_in_use "$HOST_PORT_VALUE"; then
  die "HOST_PORT $HOST_PORT_VALUE is already in use on this host; run ./host-preflight.sh and set another one in .env"
fi
image_exists "$TAG" || die "image $IMAGE_NAME:$TAG is not loaded on this host (run ship.ps1 first, or: docker image ls $IMAGE_NAME)"
dc config -q || die "compose file does not validate"
log "checks passed"

SERVICES=(db api)
[ "$NO_TUNNEL" -eq 1 ] || SERVICES+=(cloudflared)

echo "-- other containers on this host (must be unchanged by this script):"
BEFORE=$(neighbors); echo "${BEFORE:-(none)}"

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "--check-only: would run: compose -p $PROJECT up -d ${SERVICES[*]}  with IMAGE_TAG=$TAG"
  exit 0
fi

# ---- 2. record state first, so rollback.sh works even if the new image never becomes healthy ----
if [ "$TAG" != "$CURRENT" ]; then state_write "$TAG" "${CURRENT:-$TAG}"; fi
"${DOCKER[@]}" tag "$IMAGE_NAME:$TAG" "$IMAGE_NAME:latest-local"

# ---- 3. up (only this project's services) ----
log "starting: ${SERVICES[*]}"
dc up -d "${SERVICES[@]}"

# ---- 4. wait ----
ok=1
wait_healthy db "$WAIT_SECS" || ok=0
wait_healthy api "$WAIT_SECS" || ok=0
if [ "$NO_TUNNEL" -eq 0 ]; then wait_healthy cloudflared "$WAIT_SECS" || ok=0; fi

# ---- 5. report ----
echo
dc ps
echo
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${HOST_PORT_VALUE}/api/v1/health" || true)
  log "GET http://127.0.0.1:${HOST_PORT_VALUE}/api/v1/health -> ${code:-no response}"
  [ "$code" = "200" ] || ok=0
fi
AFTER=$(neighbors)
if [ "$BEFORE" = "$AFTER" ]; then log "other containers unchanged"; else warn "the list of other containers changed:"; echo "$AFTER"; fi

if [ "$ok" -ne 1 ]; then
  echo "---- last api log lines ----"; dc logs --tail 40 api || true
  die "deployment is not healthy. Roll back with: ./rollback.sh --apply   (previous tag: $(state_get PREVIOUS_IMAGE_TAG))"
fi
log "done: $IMAGE_NAME:$TAG is up"
