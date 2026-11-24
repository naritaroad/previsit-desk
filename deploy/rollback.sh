#!/usr/bin/env bash
# Runs ON THE HOST in the deploy directory. Switches the api container back to the previous image.
# Dry-run by default: prints the plan and changes nothing until --apply is given.
# Only the api service of the previsit-desk project is recreated; db, cloudflared and every
# other project on the host are left alone.
#
#   ./rollback.sh                       # show what would happen
#   ./rollback.sh --apply               # go back to the previous tag from .deploy-state
#   ./rollback.sh --apply --to TAG      # go to a specific tag that is loaded on this host
#
# Database note: migrations only move forward. If the newer image applied a migration that the older
# image does not know, the older image may refuse to start. Take a pg_dump before each upgrade (DEPLOY.md).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=remote-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/remote-common.sh"

APPLY=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --to) TARGET="${2:?--to needs a tag}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

detect_docker
check_env_file
CURRENT=$(state_get IMAGE_TAG)
PREVIOUS=$(state_get PREVIOUS_IMAGE_TAG)
[ -n "$TARGET" ] || TARGET="$PREVIOUS"
[ -n "$TARGET" ] || die "no previous tag recorded in .deploy-state; use --to TAG (docker image ls $IMAGE_NAME lists what is loaded)"
[[ "$TARGET" =~ ^[A-Za-z0-9_.-]+$ ]] || die "tag has unexpected characters"
[ "$TARGET" != "$CURRENT" ] || die "target tag equals the current tag ($CURRENT); nothing to roll back"
image_exists "$TARGET" || die "image $IMAGE_NAME:$TARGET is not on this host (loaded tags: $("${DOCKER[@]}" image ls "$IMAGE_NAME" --format '{{.Tag}}' | tr '\n' ' '))"

log "current=${CURRENT:-none} -> target=$TARGET"
log "plan: retag $IMAGE_NAME:$TARGET as latest-local; compose -p $PROJECT up -d --no-deps api; wait for health"
if [ "$APPLY" -ne 1 ]; then log "dry-run: nothing changed. Add --apply to do it."; exit 0; fi

BEFORE=$(neighbors)
"${DOCKER[@]}" tag "$IMAGE_NAME:$TARGET" "$IMAGE_NAME:latest-local"
state_write "$TARGET" "${CURRENT:-$TARGET}"
dc up -d --no-deps api

if ! wait_healthy api 120; then
  dc logs --tail 40 api || true
  die "api did not become healthy on $TARGET. State now says current=$TARGET previous=${CURRENT:-none}; run ./rollback.sh --apply again to flip back."
fi

HP="$(env_get HOST_PORT)"; HP="${HP:-18088}"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${HP}/api/v1/health" || true)
  log "GET http://127.0.0.1:${HP}/api/v1/health -> ${code:-no response}"
  [ "$code" = "200" ] || die "health endpoint did not return 200"
fi
dc ps
AFTER=$(neighbors)
if [ "$BEFORE" = "$AFTER" ]; then log "other containers unchanged"; else warn "the list of other containers changed:"; echo "$AFTER"; fi
log "rolled back to $IMAGE_NAME:$TARGET"
