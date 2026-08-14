#!/usr/bin/env bash
set -Eeuo pipefail

resolve_self() {
  local src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}

ROOT="$(resolve_self)"
BIN_DIR="$ROOT/bin"
PATH="$BIN_DIR:$PATH"
export PATH

DOCTOR=0
NO_TUNNEL=0
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --doctor|-d)
      DOCTOR=1
      shift
      ;;
    --no-tunnel)
      NO_TUNNEL=1
      shift
      ;;
    --workspace)
      WORKSPACE="${2:?--workspace requires a value}"
      shift 2
      ;;
    --port)
      PORT="${2:?--port requires a value}"
      shift 2
      ;;
    --public-hostname)
      PUBLIC_HOSTNAME="${2:?--public-hostname requires a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

WORKSPACE="$(mkdir -p "$WORKSPACE" && cd "$WORKSPACE" && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2codex.XXXXXX")"
SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

need_tool() {
  local name
  for name in "$@"; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  echo "missing required command: $*" >&2
  exit 1
}

NODE="$(need_tool node)"
CLOUDFLARED=""
CLI="$ROOT/dist/cli.js"

node_fetch_ok() {
  local url="$1"
  "$NODE" -e '
const url = process.argv[1];
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4000);
fetch(url, { signal: controller.signal })
  .then((res) => process.exit(res.status >= 200 && res.status < 500 ? 0 : 1))
  .catch(() => process.exit(1))
  .finally(() => clearTimeout(timeout));
' "$url"
}

wait_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for ((i = 0; i < tries; i++)); do
    if node_fetch_ok "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become ready: $url" >&2
  return 1
}

node_public_fetch_ok() {
  local url="$1"
  "$NODE" -e '
const https = require("node:https");
const target = new URL(process.argv[1]);

async function resolveA(host) {
  const query = new URL("https://cloudflare-dns.com/dns-query");
  query.searchParams.set("name", host);
  query.searchParams.set("type", "A");
  const response = await fetch(query, { headers: { accept: "application/dns-json" } });
  if (!response.ok) return [];
  const json = await response.json();
  return (json.Answer ?? []).filter((answer) => answer.type === 1 && answer.data).map((answer) => answer.data);
}

function requestIp(ip) {
  return new Promise((resolve) => {
    const req = https.request({
      host: ip,
      port: target.port ? Number(target.port) : 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      servername: target.hostname,
      headers: { Host: target.host },
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

(async () => {
  if (target.protocol !== "https:") process.exit(1);
  for (const ip of await resolveA(target.hostname)) {
    if (await requestIp(ip)) process.exit(0);
  }
  process.exit(1);
})().catch(() => process.exit(1));
' "$url"
}

wait_public_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for ((i = 0; i < tries; i++)); do
    if node_fetch_ok "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become ready: $url" >&2
  return 1
}

start_logged() {
  local name="$1"
  shift
  "$@" >"$TMP_DIR/$name.out.log" 2>"$TMP_DIR/$name.err.log" &
  echo "$!"
}

read_logs() {
  local name="$1"
  cat "$TMP_DIR/$name.out.log" "$TMP_DIR/$name.err.log" 2>/dev/null || true
}

wait_quick_tunnel_url() {
  local tries="$1"
  local i log url
  for ((i = 0; i < tries; i++)); do
    log="$(read_logs cloudflared)"
    url="$(printf '%s\n' "$log" | grep -Eo 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' | head -n 1 || true)"
    if [ -n "$url" ]; then
      printf '%s\n' "$url"
      return 0
    fi
    if [ -n "$TUNNEL_PID" ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "cloudflared exited early" >&2
      read_logs cloudflared >&2
      return 1
    fi
    sleep 1
  done
  echo "Quick Tunnel URL did not appear" >&2
  read_logs cloudflared >&2
  return 1
}

start_quick_tunnel_with_retry() {
  local attempts="$1"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if [ "$attempt" -gt 1 ]; then
      echo "[chatgpt2codex] retrying Cloudflare tunnel ($attempt/$attempts)..." >&2
      sleep $((attempt < 5 ? attempt * 2 : 10))
    fi

    TUNNEL_PID="$(start_logged cloudflared "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT")"
    if PUBLIC_URL="$(wait_quick_tunnel_url 45)"; then
      return 0
    fi
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
  done
  return 1
}

if [ ! -f "$CLI" ]; then
  echo "dist/cli.js was not found under $ROOT" >&2
  exit 1
fi

if [ "$DOCTOR" -eq 1 ]; then
  exec "$NODE" "$CLI" doctor
fi

# Several workspace roots can be registered. They arrive newline-separated in
# CHATGPT2CODEX_WORKSPACES (a delimiter that cannot appear in a POSIX path,
# unlike the ':' or ',' a path could legitimately contain) and are forwarded as
# repeated --workspace flags. WORKSPACE remains the single-root fallback so an
# older configuration keeps working unchanged.
WORKSPACES_FILE="${CHATGPT2CODEX_WORKSPACES_FILE:-${XDG_DATA_HOME:-$HOME/.local/share}/chatgpt2codex/workspaces.txt}"
WORKSPACE_ARGS=()

add_workspace_root() {
  local root="${1#"${1%%[![:space:]]*}"}"   # trim leading space
  root="${root%"${root##*[![:space:]]}"}"   # trim trailing space
  [[ -z "$root" || "$root" == \#* ]] && return 0
  [[ "$root" == "~/"* ]] && root="$HOME/${root:2}"
  mkdir -p "$root" 2>/dev/null || true
  WORKSPACE_ARGS+=(--workspace "$root")
}

if [[ -n "${CHATGPT2CODEX_WORKSPACES:-}" ]]; then
  while IFS= read -r workspace_root; do
    add_workspace_root "$workspace_root"
  done <<< "$CHATGPT2CODEX_WORKSPACES"
elif [[ -f "$WORKSPACES_FILE" ]]; then
  while IFS= read -r workspace_root || [[ -n "$workspace_root" ]]; do
    add_workspace_root "$workspace_root"
  done < "$WORKSPACES_FILE"
fi

if [[ "${#WORKSPACE_ARGS[@]}" -eq 0 ]]; then
  WORKSPACE_ARGS=(--workspace "$WORKSPACE")
fi
echo "[chatgpt2codex] workspace roots ($(( ${#WORKSPACE_ARGS[@]} / 2 ))):"
for ((wi = 1; wi < ${#WORKSPACE_ARGS[@]}; wi += 2)); do
  wroot="${WORKSPACE_ARGS[wi]}"
  if [[ -d "$wroot" && -r "$wroot" ]]; then
    echo "  - $wroot"
  else
    echo "  - $wroot  [UNREADABLE]"
  fi
done

doctor_text="$("$NODE" "$CLI" doctor 2>/dev/null || true)"
if [[ "$doctor_text" != *"owner token configured"* || "${CHATGPT2CODEX_ROTATE_OWNER_TOKEN:-}" == "1" ]]; then
  init_args=(init "${WORKSPACE_ARGS[@]}")
  [ "${CHATGPT2CODEX_ROTATE_OWNER_TOKEN:-}" = "1" ] && init_args+=(--rotate-owner-token)
  echo "[chatgpt2codex] initializing local owner token..."
  "$NODE" "$CLI" "${init_args[@]}"
  echo
  echo "[chatgpt2codex] save the printed owner token securely."
fi

if [ "$NO_TUNNEL" -eq 1 ]; then
  PUBLIC_URL="http://127.0.0.1:$PORT"
else
  CLOUDFLARED="$(need_tool cloudflared)"
  echo "[chatgpt2codex] 1/3 starting Cloudflare tunnel..."
  if [ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ] || [ -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]; then
    if [ -z "$PUBLIC_HOSTNAME" ]; then
      echo "PUBLIC_HOSTNAME is required with CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME." >&2
      exit 1
    fi
    PUBLIC_URL="https://$PUBLIC_HOSTNAME"
    if [ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]; then
      TUNNEL_PID="$(start_logged cloudflared "$CLOUDFLARED" tunnel --no-autoupdate run --token "$CLOUDFLARED_TUNNEL_TOKEN")"
    else
      TUNNEL_PID="$(start_logged cloudflared "$CLOUDFLARED" tunnel --no-autoupdate run --url "http://127.0.0.1:$PORT" "$CLOUDFLARED_TUNNEL_NAME")"
    fi
    sleep 3
  elif [ -n "$PUBLIC_HOSTNAME" ]; then
    PUBLIC_URL="https://$PUBLIC_HOSTNAME"
    TUNNEL_PID="$(start_logged cloudflared "$CLOUDFLARED" tunnel --hostname "$PUBLIC_HOSTNAME" --url "http://127.0.0.1:$PORT" --no-autoupdate)"
    sleep 3
  else
    if ! start_quick_tunnel_with_retry 4; then
      echo "Quick Tunnel URL did not appear" >&2
      read_logs cloudflared >&2
      exit 1
    fi
  fi
fi

echo "[chatgpt2codex] 2/3 starting local HTTP/OAuth MCP server..."
export CHATGPT2CODEX_AUTO_CAPTURE="${CHATGPT2CODEX_AUTO_CAPTURE:-0}"
server_args=("$NODE" "$CLI" serve --http --port "$PORT" --public-url "$PUBLIC_URL" "${WORKSPACE_ARGS[@]}")
if [ -n "${CHATGPT2CODEX_ACTIVE_PROJECT_ROOT:-}" ]; then
  server_args+=(--active-project-root "$CHATGPT2CODEX_ACTIVE_PROJECT_ROOT")
  server_args+=(--active-project-preset "${CHATGPT2CODEX_ACTIVE_PROJECT_PRESET:-full-write}")
fi
SERVER_PID="$(start_logged server "${server_args[@]}")"
if ! wait_http_ok "http://127.0.0.1:$PORT/healthz" 30 "local server"; then
  read_logs server >&2
  exit 1
fi

echo
echo "============================================================"
echo " chatgpt2codex is ready"
echo "============================================================"
echo " ChatGPT connector MCP URL:"
echo
echo "   $PUBLIC_URL/mcp"
echo
echo " Notes:"
echo "   - Keep this process running."
echo "   - Ctrl+C stops server and tunnel."
echo "   - Use CHATGPT2CODEX_ROTATE_OWNER_TOKEN=1 to rotate the owner token."
if [ "$NO_TUNNEL" -eq 0 ] && [ -z "$PUBLIC_HOSTNAME" ] && [ -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" ] && [ -z "${CLOUDFLARED_TUNNEL_NAME:-}" ]; then
  echo "   - This trycloudflare.com URL is temporary and changes when the tunnel restarts."
  echo "   - For a ChatGPT app you keep using, configure a stable PUBLIC_HOSTNAME/named tunnel."
fi
echo "============================================================"

if [ "$NO_TUNNEL" -eq 0 ]; then
  echo "[chatgpt2codex] 3/3 verifying public endpoint health..."
  if wait_public_http_ok "$PUBLIC_URL/healthz" 60 "public endpoint"; then
    echo "[chatgpt2codex] public endpoint health ok."
  else
    echo "[chatgpt2codex] warning: local server is healthy, but public endpoint health is not ready yet." >&2
    echo "[chatgpt2codex] Cloudflared log:" >&2
    read_logs cloudflared >&2
  fi
else
  echo "[chatgpt2codex] 3/3 tunnel skipped by --no-tunnel"
fi

while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited" >&2
    read_logs server >&2
    exit 1
  fi
  if [ -n "$TUNNEL_PID" ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "cloudflared exited" >&2
    read_logs cloudflared >&2
    exit 1
  fi
  sleep 1
done
