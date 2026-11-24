#!/usr/bin/env bash
# READ-ONLY survey of the host before the first deployment. Changes nothing.
# Prints memory, disk, listening ports, running containers and a free HOST_PORT to use.
#   ./host-preflight.sh            # prefers 18088
#   HOST_PORT=18090 ./host-preflight.sh
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=remote-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/remote-common.sh"

# Sum of the mem_limit values in compose.prod.yaml (db 256 + api 256 + cloudflared 128) plus a margin.
NEED_MIB=800

section() { printf '\n==== %s ====\n' "$*"; }

detect_docker

section "System"
uname -sr
# shellcheck source=/dev/null
. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown OS}"
echo "cpus: $(nproc)"

section "Memory (free -m)"
free -m
avail=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)
echo "MemAvailable: ${avail} MiB (this stack's limits add up to 640 MiB; want at least ${NEED_MIB} MiB free)"
if [ "$avail" -lt "$NEED_MIB" ]; then warn "available memory is below ${NEED_MIB} MiB; check swap and the other containers before deploying"; fi
echo "-- swap"; swapon --show 2>/dev/null || echo "(no swap listed)"

section "Disk (df -h)"
df -h / 2>/dev/null
[ -d /var/lib/docker ] && df -h /var/lib/docker 2>/dev/null | tail -n +2 || true

section "Listening TCP ports (ss -ltnp)"
if sudo -n true 2>/dev/null; then sudo -n ss -ltnp; else ss -ltnp 2>/dev/null || ss -ltn; echo "(process names need root; showing what is visible)"; fi

section "Docker"
"${DOCKER[@]}" version --format 'server {{.Server.Version}} / client {{.Client.Version}}' 2>/dev/null || true
"${DOCKER[@]}" compose version 2>/dev/null || warn "docker compose plugin not found"
echo "-- docker ps"
"${DOCKER[@]}" ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo "-- compose projects"
"${DOCKER[@]}" compose ls -a 2>/dev/null || true
echo "-- volumes / networks that already carry our name"
"${DOCKER[@]}" volume ls --format '{{.Name}}' | grep -E "^${PROJECT}[_-]" || echo "(no previsit-desk volumes yet)"
"${DOCKER[@]}" network ls --format '{{.Name}}' | grep -E "^${PROJECT}[_-]" || echo "(no previsit-desk networks yet)"
echo "-- images"
"${DOCKER[@]}" image ls "$IMAGE_NAME" --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null || true

section "Existing host-level cloudflared (information only; this deployment never touches it)"
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active cloudflared 2>/dev/null || echo "(no cloudflared systemd unit active, or not visible)"
fi

section "Free HOST_PORT for the API (loopback only)"
preferred="${HOST_PORT:-18088}"
chosen=""
for p in $(seq "$preferred" $((preferred + 40))); do
  if port_in_use "$p"; then
    echo "  $p: in use"
  else
    chosen=$p
    echo "  $p: free"
    break
  fi
done
for known in 8080 20241; do
  if port_in_use "$known"; then echo "  note: $known is in use by something else (expected for grex / its cloudflared); we do not use it"; fi
done
if [ -n "$chosen" ]; then
  echo
  echo "SUGGESTED_HOST_PORT=$chosen   (put HOST_PORT=$chosen in .env)"
else
  die "no free port found from $preferred to $((preferred + 40))"
fi
