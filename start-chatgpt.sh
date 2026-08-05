#!/usr/bin/env bash
# chatgpt2codex - ChatGPT connector one-shot launcher.
#
# Starts the local HTTP/OAuth MCP server. Default mode is loopback-only.
# Set CHATGPT2CODEX_EXPOSE_WEB=1 only while ChatGPT web needs to reach it.
# Keep this terminal open. Ctrl+C tears down the server and optional tunnel.
#
# Optional env:
#   WORKSPACE="$HOME/workspace"
#   PORT=7979
#   CHATGPT2CODEX_EXPOSE_WEB=1            # opt-in public tunnel for ChatGPT web
#   CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES=20   # optional explicit idle shutdown
#   PUBLIC_HOSTNAME=your-domain.example.com   # optional stable host for web mode
#   CHATGPT2CODEX_ACTIVE_PROJECT_ROOT=/path/to/project
#   CLOUDFLARED_TUNNEL_TOKEN=...      # preferred if configured in Cloudflare dashboard
#   CLOUDFLARED_TUNNEL_NAME=...       # optional named tunnel from local cloudflared config
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$ROOT/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"
PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-}"
EXPOSE_WEB="${CHATGPT2CODEX_EXPOSE_WEB:-0}"
IDLE_SHUTDOWN_MINUTES="${CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES:-}"
CLOUDFLARED_TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-}"
CFLOG="$(mktemp -t chatgpt2codex-cf.XXXX.log)"
SRVLOG="$(mktemp -t chatgpt2codex-server.XXXX.log)"
DOCTOR_SCRIPT="$ROOT/macos-dependency-doctor.sh"
if [[ ! -f "$DOCTOR_SCRIPT" && -f "$ROOT/scripts/macos-dependency-doctor.sh" ]]; then
  DOCTOR_SCRIPT="$ROOT/scripts/macos-dependency-doctor.sh"
fi

# Where preserved failure logs go. The temp logs used to be deleted by the
# EXIT trap immediately after the failure message printed their paths, so the
# one thing needed to diagnose a failed start was always already gone.
DIAG_DIR="${CHATGPT2CODEX_DIAG_DIR:-$HOME/Library/Logs/ChatGPT To Codex}"

preserve_logs() {
  mkdir -p "$DIAG_DIR" 2>/dev/null || return 0
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  [[ -s "$CFLOG" ]] && cp "$CFLOG" "$DIAG_DIR/cloudflared-$stamp.log" 2>/dev/null || true
  [[ -s "$SRVLOG" ]] && cp "$SRVLOG" "$DIAG_DIR/server-$stamp.log" 2>/dev/null || true
  echo "[chatgpt2codex] failure logs kept in: $DIAG_DIR" >&2
}

cleanup() {
  local status=$?
  echo
  echo "[chatgpt2codex] stopping server/tunnel..."
  # Keep the evidence when we are going down because something failed.
  [[ "$status" -ne 0 ]] && preserve_logs
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
  [[ -n "${CF_PID:-}" ]] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$CFLOG" "$SRVLOG"
}
trap cleanup EXIT INT TERM

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[chatgpt2codex] missing command: $1" >&2
    exit 1
  fi
}

run_macos_doctor() {
  if [[ "$(uname -s)" != "Darwin" || ! -f "$DOCTOR_SCRIPT" ]]; then
    return 0
  fi
  echo "[chatgpt2codex] checking macOS runtime dependencies..."
  if ! CHATGPT2CODEX_DOCTOR_REPAIR=1 bash "$DOCTOR_SCRIPT" --repair; then
    echo "[chatgpt2codex] macOS doctor found issues that could not be fixed automatically." >&2
    echo "[chatgpt2codex] open ChatGPT To Codex settings -> Run Doctor for the full report." >&2
    exit 1
  fi
}

sleep_1s() {
  node -e 'setTimeout(function(){}, 1000)'
}

wait_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for i in $(seq 1 "$tries"); do
    # --max-time matters: without it a hung connection can stall each attempt
    # indefinitely, so "20 tries" turns into an unbounded wait with the app
    # stuck on a progress line and no way to tell what is happening.
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep_1s
  done
  echo "[chatgpt2codex] $label did not become ready: $url" >&2
  return 1
}

cloudflare_doh_ips() {
  local host="$1"
  local query_url="https://cloudflare-dns.com/dns-query?name=${host}&type=A"
  curl --silent --show-error --resolve "cloudflare-dns.com:443:1.1.1.1" \
    -H "accept: application/dns-json" --max-time 20 "$query_url" |
    node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const json = JSON.parse(input);
          for (const answer of json.Answer ?? []) {
            if (answer.type === 1 && answer.data) console.log(answer.data);
          }
        } catch {}
      });
    '
}

http_ok_with_curl_resolve() {
  local url="$1"
  local host
  host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$url" 2>/dev/null || true)"
  [[ -z "$host" ]] && return 1
  local ip
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    if curl -fsS --resolve "$host:443:$ip" --max-time 20 "$url" >/dev/null 2>&1; then
      return 0
    fi
  done < <(cloudflare_doh_ips "$host")
  return 1
}

wait_public_http_ok() {
  local url="$1"
  local tries="$2"
  local label="$3"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS --max-time 10 "$url" >/dev/null 2>&1 || http_ok_with_curl_resolve "$url"; then
      return 0
    fi
    sleep_1s
  done
  echo "[chatgpt2codex] $label did not become ready: $url" >&2
  return 1
}

wait_quick_tunnel_url() {
  local tries="$1"
  local i
  for i in $(seq 1 "$tries"); do
    local url
    url="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$CFLOG" | head -n 1 || true)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
    if [[ -n "${CF_PID:-}" ]] && ! kill -0 "$CF_PID" 2>/dev/null; then
      echo "[chatgpt2codex] cloudflared exited early. Log:" >&2
      cat "$CFLOG" >&2
      return 1
    fi
    sleep_1s
  done
  echo "[chatgpt2codex] quick tunnel URL did not appear. Log:" >&2
  cat "$CFLOG" >&2
  return 1
}

start_quick_tunnel_with_retry() {
  local attempts="$1"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    if [[ "$attempt" -gt 1 ]]; then
      echo "[chatgpt2codex] retrying public tunnel ($attempt/$attempts)..." >&2
      sleep "$(( attempt < 5 ? attempt * 2 : 10 ))"
    fi

    cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$CFLOG" 2>&1 &
    CF_PID=$!
    if PUBLIC_URL="$(wait_quick_tunnel_url 45)"; then
      return 0
    fi
    kill "$CF_PID" 2>/dev/null || true
    wait "$CF_PID" 2>/dev/null || true
    CF_PID=""
  done
  return 1
}

# Locate an existing cloudflared config that already publishes $1.
#
# cloudflared only auto-discovers ~/.cloudflared/config.yml (or .yaml). A
# perfectly good named-tunnel config saved under any other name is invisible
# to it, so a user who has already run `cloudflared tunnel create` + `route
# dns` still ends up on a random quick tunnel. Find such a config ourselves
# and pass it explicitly with --config.
find_cloudflared_config() {
  local host="$1" candidate
  if [[ -n "${CLOUDFLARED_CONFIG:-}" && -f "${CLOUDFLARED_CONFIG}" ]]; then
    printf '%s\n' "$CLOUDFLARED_CONFIG"
    return 0
  fi
  [[ -n "$host" ]] || return 1
  for candidate in "$HOME/.cloudflared"/*.yml "$HOME/.cloudflared"/*.yaml; do
    [[ -f "$candidate" ]] || continue
    # Must name a tunnel and route the hostname we intend to serve.
    if grep -Eq '^[[:space:]]*tunnel:[[:space:]]*[^[:space:]]' "$candidate" 2>/dev/null &&
       grep -Eq "hostname:[[:space:]]*${host//./\\.}([[:space:]]|$)" "$candidate" 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

port_busy() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(0));
    server.once("listening", () => server.close(() => process.exit(1)));
    server.listen(port, "127.0.0.1");
  ' "$PORT"
}

wait_port_free() {
  # A restart terminates the previous server and starts a new one straight
  # away, but the old process can hold the listening socket for a second or
  # two while it shuts down. Give it that time instead of failing outright.
  local tries="${1:-20}"
  local i
  for i in $(seq 1 "$tries"); do
    if ! port_busy; then
      return 0
    fi
    sleep_1s
  done
  return 1
}

stop_stale_runtime_processes() {
  local stopped=()
  local patterns=(
    "dist/cli.js serve --http --port $PORT"
    "cloudflared.*127[.]0[.]0[.]1:$PORT"
    "cloudflared.*localhost:$PORT"
  )
  local pattern pid command
  for pattern in "${patterns[@]}"; do
    while IFS= read -r pid; do
      [[ -z "$pid" || "$pid" == "$$" || "$pid" == "${PPID:-}" ]] && continue
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      [[ -z "$command" ]] && continue
      if [[ "$command" == *"$ROOT"* || "$command" == *"cloudflared"* ]]; then
        kill "$pid" 2>/dev/null || true
        stopped+=("$pid")
      fi
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
  if [[ "${#stopped[@]}" -gt 0 ]]; then
    echo "[chatgpt2codex] stopped stale runtime process(es): ${stopped[*]}"
    sleep 1
  fi
}

run_macos_doctor

need_cmd node
need_cmd curl

mkdir -p "$WORKSPACE"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

cd "$ROOT"

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  need_cmd npm
  echo "[chatgpt2codex] dist/cli.js missing; building..."
  npm run build
fi

stop_stale_runtime_processes
if ! wait_port_free 20; then
  echo "[chatgpt2codex] port $PORT is already in use and did not free up." >&2
  echo "[chatgpt2codex] Something else is listening on 127.0.0.1:$PORT. Find it with:" >&2
  echo "[chatgpt2codex]   lsof -nP -iTCP:$PORT -sTCP:LISTEN" >&2
  echo "[chatgpt2codex] Then stop it, or start on another port with PORT=xxxx." >&2
  exit 1
fi

if ! node "$ROOT/dist/cli.js" doctor 2>/dev/null | grep -q "owner token configured"; then
  echo "[chatgpt2codex] owner token is not configured." >&2
  echo "[chatgpt2codex] Open ChatGPT To Codex settings and generate or set an owner token first." >&2
  echo "[chatgpt2codex] CLI fallback: node \"$ROOT/dist/cli.js\" owner-token --generate --workspace \"$WORKSPACE\"" >&2
  exit 1
fi

USE_TUNNEL=0
if [[ "$EXPOSE_WEB" == "1" || -n "$PUBLIC_HOSTNAME" || -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
  USE_TUNNEL=1
fi

if [[ "$USE_TUNNEL" == "1" ]]; then
  need_cmd cloudflared
  echo "[chatgpt2codex] 1/3 starting public tunnel..."
  # A named/token tunnel needs a hostname to publish under. Missing one used
  # to abort the whole launch, so a stale tunnel name left over in settings
  # made the app fail to start every single time with no way to recover from
  # the UI. Warn and fall back to a temporary quick tunnel instead: the user
  # still gets a working connector URL, and the warning says what to fix.
  if [[ -z "$PUBLIC_HOSTNAME" && ( -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ) ]]; then
    echo "[chatgpt2codex] warning: a Cloudflare tunnel name/token is configured but PUBLIC_HOSTNAME is empty." >&2
    echo "[chatgpt2codex] warning: set the public hostname in Settings (or clear the tunnel name)." >&2
    echo "[chatgpt2codex] warning: falling back to a temporary quick tunnel for this run." >&2
    CLOUDFLARED_TUNNEL_TOKEN=""
    CLOUDFLARED_TUNNEL_NAME=""
  fi

  # `cloudflared tunnel --hostname <host> --url <origin>` does NOT publish a
  # custom hostname on current cloudflared. The flag is accepted and then
  # silently ignored: cloudflared requests a random *.trycloudflare.com quick
  # tunnel instead, logs "Requesting new quick Tunnel", and connects fine.
  # Everything looks healthy while the custom hostname serves nothing — so the
  # health check below waited on an address that could never come up, and then
  # tore down a perfectly working server. Publishing a custom hostname needs a
  # NAMED tunnel (a dashboard token, or a tunnel name plus credentials and a
  # DNS route). Without one, say so plainly and use the quick tunnel we can
  # actually get, so the app still ends up usable.
  # Before falling back, check whether this machine already has a named-tunnel
  # config for the requested hostname. If it does, that is exactly what the
  # user wants and it just was not being used.
  CF_CONFIG=""
  if [[ -n "$PUBLIC_HOSTNAME" && -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]]; then
    if CF_CONFIG="$(find_cloudflared_config "$PUBLIC_HOSTNAME")"; then
      echo "[chatgpt2codex] using existing Cloudflare tunnel config: $CF_CONFIG"
    else
      CF_CONFIG=""
    fi
  fi

  if [[ -n "$PUBLIC_HOSTNAME" && -z "$CF_CONFIG" && -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" && -z "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
    echo "[chatgpt2codex] warning: '$PUBLIC_HOSTNAME' cannot be published without a named Cloudflare tunnel." >&2
    echo "[chatgpt2codex] warning: cloudflared ignores --hostname unless a tunnel token/name is configured." >&2
    echo "[chatgpt2codex] warning: using a temporary quick tunnel for this run instead." >&2
    echo "[chatgpt2codex] warning: for a stable '$PUBLIC_HOSTNAME', set a tunnel token in Settings, or run:" >&2
    echo "[chatgpt2codex] warning:   cloudflared tunnel login" >&2
    echo "[chatgpt2codex] warning:   cloudflared tunnel create chatgpt2codex" >&2
    echo "[chatgpt2codex] warning:   cloudflared tunnel route dns chatgpt2codex $PUBLIC_HOSTNAME" >&2
    echo "[chatgpt2codex] warning: then put the tunnel name in Settings." >&2
    PUBLIC_HOSTNAME=""
  fi

  if [[ -n "$CF_CONFIG" || -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" || -n "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
    PUBLIC_URL="https://${PUBLIC_HOSTNAME}"
    if [[ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]]; then
      cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARED_TUNNEL_TOKEN" >"$CFLOG" 2>&1 &
    elif [[ -n "$CF_CONFIG" ]]; then
      # The config supplies both the tunnel id and the ingress rules. Passing
      # --url here as well would conflict with those rules, so do not.
      cloudflared --config "$CF_CONFIG" tunnel --no-autoupdate run >"$CFLOG" 2>&1 &
    else
      cloudflared tunnel --no-autoupdate run --url "http://127.0.0.1:$PORT" "$CLOUDFLARED_TUNNEL_NAME" >"$CFLOG" 2>&1 &
    fi
    CF_PID=$!
  else
    if ! start_quick_tunnel_with_retry 4; then
      echo "[chatgpt2codex] quick tunnel URL did not appear. Log:" >&2
      cat "$CFLOG" >&2
      exit 1
    fi
  fi

  if [[ -z "${PUBLIC_URL:-}" ]]; then
    PUBLIC_URL="$(wait_quick_tunnel_url 30)"
  else
    for _ in $(seq 1 3); do
      if ! kill -0 "$CF_PID" 2>/dev/null; then
        echo "[chatgpt2codex] cloudflared exited early. Log:" >&2
        cat "$CFLOG" >&2
        exit 1
      fi
      sleep_1s
    done
  fi
else
  PUBLIC_URL="http://127.0.0.1:$PORT"
  echo "[chatgpt2codex] 1/2 loopback-only mode; no public tunnel."
fi

echo "[chatgpt2codex] 2/3 starting local HTTP/OAuth MCP server..."
ACTIVE_PROJECT_ARGS=()
if [[ -n "${CHATGPT2CODEX_ACTIVE_PROJECT_ROOT:-}" ]]; then
  ACTIVE_PROJECT_ARGS+=(--active-project-root "$CHATGPT2CODEX_ACTIVE_PROJECT_ROOT")
  ACTIVE_PROJECT_ARGS+=(--active-project-preset "${CHATGPT2CODEX_ACTIVE_PROJECT_PRESET:-full-write}")
fi
SERVER_ARGS=(serve --http --port "$PORT" --public-url "$PUBLIC_URL" --workspace "$WORKSPACE")
if [[ -n "$IDLE_SHUTDOWN_MINUTES" ]]; then
  SERVER_ARGS+=(--idle-shutdown-minutes "$IDLE_SHUTDOWN_MINUTES")
fi
node "$ROOT/dist/cli.js" "${SERVER_ARGS[@]}" ${ACTIVE_PROJECT_ARGS[@]+"${ACTIVE_PROJECT_ARGS[@]}"} >"$SRVLOG" 2>&1 &
SRV_PID=$!
if ! wait_http_ok "http://127.0.0.1:$PORT/healthz" 20 "local server"; then
  echo "[chatgpt2codex] server log: $SRVLOG" >&2
  cat "$SRVLOG" >&2
  exit 1
fi

if [[ "$USE_TUNNEL" == "1" ]]; then
  echo "[chatgpt2codex] 3/3 checking public health..."
  if ! wait_public_http_ok "$PUBLIC_URL/healthz" 60 "public endpoint"; then
    echo "[chatgpt2codex] ---------------------------------------------------" >&2
    echo "[chatgpt2codex] The LOCAL server started fine; the PUBLIC address is" >&2
    echo "[chatgpt2codex] not reachable, so ChatGPT web cannot connect yet." >&2
    echo "[chatgpt2codex] Local endpoint that IS working: http://127.0.0.1:$PORT/mcp" >&2
    echo "[chatgpt2codex] Failing public endpoint:        $PUBLIC_URL/healthz" >&2
    echo "[chatgpt2codex] --- cloudflared output ------------------------------" >&2
    # Print the tunnel's own error inline. Pointing at a temp file the EXIT
    # trap is about to delete is what made this failure undiagnosable.
    if [[ -s "$CFLOG" ]]; then
      tail -n 60 "$CFLOG" >&2
    else
      echo "[chatgpt2codex] (cloudflared produced no output at all)" >&2
    fi
    echo "[chatgpt2codex] ----------------------------------------------------" >&2
    if [[ -n "$PUBLIC_HOSTNAME" ]]; then
      echo "[chatgpt2codex] The named tunnel connected but '$PUBLIC_HOSTNAME' is not serving." >&2
      echo "[chatgpt2codex] Check that the tunnel has a DNS route to this hostname:" >&2
      echo "[chatgpt2codex]   cloudflared tunnel route dns <tunnel-name> $PUBLIC_HOSTNAME" >&2
      echo "[chatgpt2codex] and that the tunnel's ingress points at http://127.0.0.1:$PORT" >&2
    fi
    exit 1
  fi
fi

cat <<EOF

============================================================
 chatgpt2codex is ready
============================================================
 MCP URL:

   ${PUBLIC_URL}/mcp

OAuth owner token:
   Use the private owner token you generated in ChatGPT To Codex settings.
   CLI fallback:
   node "$ROOT/dist/cli.js" owner-token --generate --workspace "$WORKSPACE"

 After approval, say something like:
   "alpha-app 열어서 로그인 버그 고쳐"

Notes:
   - Keep this terminal open.
   - Ctrl+C stops server and any public tunnel.
   - Default mode is loopback-only and is not reachable from ChatGPT web.
   - Set CHATGPT2CODEX_EXPOSE_WEB=1 only while ChatGPT web needs a public URL.
   - Set PUBLIC_HOSTNAME plus CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME for a stable URL.
   - Web mode stays running unless CHATGPT2CODEX_IDLE_SHUTDOWN_MINUTES is set.
   - If the old owner token appeared in a chat/screenshot, rotate it.
============================================================
EOF

if [[ "$USE_TUNNEL" == "1" && -z "$PUBLIC_HOSTNAME" && -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" && -z "${CLOUDFLARED_TUNNEL_NAME:-}" ]]; then
  cat <<EOF
[chatgpt2codex] warning: this trycloudflare.com URL is temporary.
[chatgpt2codex] warning: ChatGPT app registration will need reconnect/update after the tunnel URL changes.
[chatgpt2codex] warning: set PUBLIC_HOSTNAME plus CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_TUNNEL_NAME for a stable URL.

EOF
fi

while true; do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    if wait "$SRV_PID"; then
      echo "[chatgpt2codex] server stopped."
      exit 0
    fi
    echo "[chatgpt2codex] server exited. Log:" >&2
    cat "$SRVLOG" >&2
    exit 1
  fi
  if [[ "$USE_TUNNEL" == "1" ]] && ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "[chatgpt2codex] cloudflared exited. Log:" >&2
    cat "$CFLOG" >&2
    exit 1
  fi
  sleep_1s
done
