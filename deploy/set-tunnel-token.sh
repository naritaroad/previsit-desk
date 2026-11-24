#!/usr/bin/env bash
# Runs ON THE HOST. Reads ONE line (the Cloudflare tunnel token) from stdin and writes it into
# .env as TUNNEL_TOKEN=..., keeping mode 600. The token never appears in a command line, the
# shell history or the output. Called by deploy/cloudflare-tunnel.ps1 over ssh:
#   <token on stdin> | ssh host "cd ~/previsit-desk && ./set-tunnel-token.sh"
# The rest of .env is copied unchanged. Refuses to run if .env does not exist yet.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

[ -f .env ] || { echo "ERROR: .env not found in $(pwd). Create it first (DEPLOY.md section 6)." >&2; exit 3; }

IFS= read -r token || true
token=$(printf '%s' "$token" | tr -d '\r\n')
case "$token" in
  ''|*[!A-Za-z0-9+/=_-]*) echo "ERROR: stdin did not contain a token-shaped single line" >&2; exit 4 ;;
esac
[ "${#token}" -ge 40 ] || { echo "ERROR: token is too short to be real" >&2; exit 4; }

umask 077
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
grep -v '^TUNNEL_TOKEN=' .env > "$tmp" || true
printf 'TUNNEL_TOKEN=%s\n' "$token" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
trap - EXIT
echo "TUNNEL_TOKEN written to $(pwd)/.env (mode $(stat -c %a .env), ${#token} characters, value not shown)"
