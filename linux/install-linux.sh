#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/dist/cli.js" ]; then
  SOURCE_DIR="$SCRIPT_DIR"
else
  SOURCE_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
fi
PREFIX=""
LAUNCH=0
INSTALL_SYSTEMD=0
USER_SYSTEMD=0
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"

usage() {
  cat <<'EOF'
Usage: install-linux.sh [options]

Options:
  --prefix PATH       Install path. Default: /opt/chatgpt2codex as root, otherwise ~/.local/share/chatgpt2codex-app
  --launch           Start chatgpt2codex after installing
  --no-launch        Install only
  --systemd          Install and start a system service (root)
  --user-systemd     Install and start a user systemd service
  --workspace PATH   Workspace used by --launch/systemd. Default: ~/workspace
  --port PORT        Port used by --launch/systemd. Default: 7979
  -h, --help         Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      PREFIX="${2:?--prefix requires a value}"
      shift 2
      ;;
    --launch)
      LAUNCH=1
      shift
      ;;
    --no-launch)
      LAUNCH=0
      shift
      ;;
    --systemd)
      INSTALL_SYSTEMD=1
      shift
      ;;
    --user-systemd)
      USER_SYSTEMD=1
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    PREFIX="/opt/chatgpt2codex"
  else
    PREFIX="$HOME/.local/share/chatgpt2codex-app"
  fi
fi

PREFIX="$(mkdir -p "$(dirname "$PREFIX")" && cd "$(dirname "$PREFIX")" && pwd)/$(basename "$PREFIX")"
WORKSPACE="$(mkdir -p "$WORKSPACE" && cd "$WORKSPACE" && pwd)"

case "$PREFIX" in
  ""|"/"|"/usr"|"/usr/local"|"/opt"|"$HOME"|"$HOME/")
    echo "refusing unsafe install prefix: $PREFIX" >&2
    exit 1
    ;;
esac

stop_existing() {
  local pids="" proc pid cmdline
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    pid="${proc##*/}"
    [ "$pid" = "$$" ] && continue
    cmdline="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null || true)"
    case " $cmdline " in
      *" $PREFIX/bin/node "*|*" $PREFIX/start-chatgpt2codex.sh "*|*" $PREFIX/chatgpt2codex "*)
        pids="$pids $pid"
        ;;
    esac
  done
  [ -n "${pids// /}" ] || return 0
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
}

link_bin() {
  local target_dir
  if [ "$(id -u)" -eq 0 ] && [ -d /usr/local/bin ]; then
    target_dir="/usr/local/bin"
  else
    target_dir="$HOME/.local/bin"
    mkdir -p "$target_dir"
  fi
  ln -sfn "$PREFIX/chatgpt2codex" "$target_dir/chatgpt2codex"
  ln -sfn "$PREFIX/start-chatgpt2codex.sh" "$target_dir/chatgpt2codex-start"
  echo "$target_dir"
}

install_systemd_service() {
  local unit_path="$1"
  local user_mode="$2"
  local wanted_by="multi-user.target"
  [ "$user_mode" = "1" ] && wanted_by="default.target"
  mkdir -p "$(dirname "$unit_path")"
  cat >"$unit_path" <<EOF
[Unit]
Description=ChatGPT To Codex local MCP bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKSPACE
Environment=WORKSPACE=$WORKSPACE
Environment=PORT=$PORT
ExecStart=$PREFIX/start-chatgpt2codex.sh --workspace $WORKSPACE --port $PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=$wanted_by
EOF

  if [ "$user_mode" = "1" ]; then
    systemctl --user daemon-reload
    systemctl --user enable --now chatgpt2codex.service
  else
    systemctl daemon-reload
    systemctl enable --now chatgpt2codex.service
  fi
}

echo "[chatgpt2codex] installing to $PREFIX"
stop_existing

tmp="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2codex-install.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/app"
cp -a "$SOURCE_DIR/." "$tmp/app/"
rm -rf "$tmp/app/.git" "$tmp/app/build"
rm -rf "$PREFIX"
mkdir -p "$(dirname "$PREFIX")"
mv "$tmp/app" "$PREFIX"

chmod +x "$PREFIX/chatgpt2codex" "$PREFIX/start-chatgpt2codex.sh" "$PREFIX/install-linux.sh" 2>/dev/null || true
find "$PREFIX/bin" -maxdepth 1 -type f -exec chmod +x {} \; 2>/dev/null || true

bin_dir="$(link_bin)"

if [ "$INSTALL_SYSTEMD" -eq 1 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "--systemd requires root. Use --user-systemd for a user service." >&2
    exit 1
  fi
  install_systemd_service "/etc/systemd/system/chatgpt2codex.service" 0
fi

if [ "$USER_SYSTEMD" -eq 1 ]; then
  install_systemd_service "$HOME/.config/systemd/user/chatgpt2codex.service" 1
fi

cat <<EOF

ChatGPT To Codex installed.
  app: $PREFIX
  commands: $bin_dir/chatgpt2codex, $bin_dir/chatgpt2codex-start

Start now:
  chatgpt2codex-start --workspace "$WORKSPACE" --port "$PORT"

EOF

if [ "$LAUNCH" -eq 1 ]; then
  exec "$PREFIX/start-chatgpt2codex.sh" --workspace "$WORKSPACE" --port "$PORT"
fi
