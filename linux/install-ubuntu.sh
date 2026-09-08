#!/usr/bin/env bash
# chatgpt2codex - Ubuntu installer.
#
# Works from a git checkout (builds first) or from a prebuilt bundle that
# already carries dist/ and node_modules/. Installs per-user, uses the system
# Node, and only ever stops a process it recorded itself.
set -Eeuo pipefail

SRC="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Running from linux/ inside a checkout means the project root is one level up.
if [ -f "$SRC/package.json" ]; then
  REPO="$SRC"
else
  REPO="$(cd -P "$SRC/.." && pwd)"
fi

PREFIX="${PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/chatgpt2codex-app}"
STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/chatgpt2codex"
BIN_DIR="$HOME/.local/bin"
WORKSPACES_FILE="$STATE_DIR/workspaces.txt"
INSTALL_SERVICE=0

usage() {
  cat <<'EOF'
Usage: install-ubuntu.sh [options]

  --prefix PATH     Install location (default: ~/.local/share/chatgpt2codex-app)
  --service         Also install a systemd --user service (autostart on login)
  -h, --help        Show this help

After installing, list the folders you want and start:
  nano ~/.local/share/chatgpt2codex/workspaces.txt
  chatgpt2codex-start
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix requires a value}"; shift 2 ;;
    --service) INSTALL_SERVICE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PREFIX" in
  ""|"/"|"/usr"|"/usr/local"|"/opt"|"$HOME"|"$HOME/")
    echo "refusing unsafe install prefix: $PREFIX" >&2; exit 1 ;;
esac

say() { printf '[chatgpt2codex] %s\n' "$*"; }

# ---------------------------------------------------------------- node check
if ! command -v node >/dev/null 2>&1; then
  say "Node.js not found, installing it from the Ubuntu repositories..."
  sudo apt-get update -qq
  sudo apt-get install -y nodejs npm
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  cat >&2 <<EOF
Node 22 or newer is required (found: $(node -v 2>/dev/null || echo none)).

Ubuntu 26.04 already ships Node 22 in its default repository:
    sudo apt-get install -y nodejs

On older releases, use NodeSource:
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
EOF
  exit 1
fi
say "using $(command -v node) ($(node -v))"

# ------------------------------------------------------------ build if needed
if [ ! -f "$REPO/dist/cli.js" ]; then
  say "no dist/ found, building from source..."
  command -v npm >/dev/null 2>&1 || { echo "npm is required to build from source" >&2; exit 1; }
  (cd "$REPO" && npm install --no-audit --no-fund && npm run build)
fi

# ------------------------------------------------------------- stop existing
# Only ever stops a process this installer recorded. install-linux.sh used a
# loose `pgrep -f "$PREFIX"`, which also matched the invoking shell and any
# editor or tail whose command line merely mentioned the path, and killed them.
PIDFILE="$STATE_DIR/server.pid"
if [ -f "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${oldpid:-}" ] && kill -0 "$oldpid" 2>/dev/null; then
    say "stopping previous instance (pid $oldpid)"
    kill "$oldpid" 2>/dev/null || true
    sleep 1
    kill -9 "$oldpid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

# ------------------------------------------------------------------- install
say "installing to $PREFIX"
# Default to a user-owned cache dir rather than the shared /tmp: on a host
# running several other agents/tools, /tmp fills up under one shared-account
# quota and a copy of a few MB of dist can fail with EDQUOT even though df
# reports plenty of free space. $HOME/.cache is ours alone.
staging_root="${TMPDIR:-$HOME/.cache/chatgpt2codex}"
mkdir -p "$staging_root"
tmp="$(mktemp -d "$staging_root/c2c-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/app"
cp -a "$REPO/dist" "$tmp/app/"
cp -a "$REPO/package.json" "$tmp/app/"
if [ -d "$REPO/node_modules" ]; then
  cp -a "$REPO/node_modules" "$tmp/app/"
else
  (cd "$tmp/app" && npm install --omit=dev --no-audit --no-fund >/dev/null)
fi

# The launcher resolves dist/ relative to its own directory, so both scripts
# belong at the install root next to dist/. install-linux.sh left them under
# linux/ while linking to the root, so every symlink it created dangled.
cp -a "$REPO/linux/start-chatgpt2codex.sh" "$tmp/app/"
cp -a "$REPO/linux/chatgpt2codex" "$tmp/app/"
chmod +x "$tmp/app/start-chatgpt2codex.sh" "$tmp/app/chatgpt2codex"

rm -rf "$PREFIX"
mkdir -p "$(dirname "$PREFIX")"
mv "$tmp/app" "$PREFIX"

mkdir -p "$BIN_DIR"
ln -sfn "$PREFIX/chatgpt2codex" "$BIN_DIR/chatgpt2codex"
ln -sfn "$PREFIX/start-chatgpt2codex.sh" "$BIN_DIR/chatgpt2codex-start"

# --------------------------------------------------------------- folder list
mkdir -p "$STATE_DIR"
if [ ! -f "$WORKSPACES_FILE" ]; then
  cat >"$WORKSPACES_FILE" <<EOF
# chatgpt2codex workspace roots - one folder per line.
# Every git repository directly inside each folder becomes a project.
# Lines starting with # are ignored, and ~ is expanded.
#
# Examples:
#   ~/Projects
#   ~/work/clients
#   /mnt/data/repos
$HOME/Projects
EOF
  mkdir -p "$HOME/Projects"
  say "created $WORKSPACES_FILE (default root: ~/Projects)"
else
  say "kept existing $WORKSPACES_FILE"
fi

# ------------------------------------------------------------------ systemd
if [ "$INSTALL_SERVICE" -eq 1 ]; then
  unit="$HOME/.config/systemd/user/chatgpt2codex.service"
  mkdir -p "$(dirname "$unit")"
  cat >"$unit" <<EOF
[Unit]
Description=chatgpt2codex local MCP bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PREFIX/start-chatgpt2codex.sh
Restart=on-failure
RestartSec=5
# For a named Cloudflare tunnel, uncomment and adjust:
#Environment=CLOUDFLARED_TUNNEL_NAME=chatgpt2codex-ubuntu
#Environment=PUBLIC_HOSTNAME=mcp2.example.com

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable chatgpt2codex.service
  say "systemd user service installed (start: systemctl --user start chatgpt2codex)"
  say "to keep it running after logout: sudo loginctl enable-linger $USER"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "NOTE: add $BIN_DIR to PATH - echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
esac

cat <<EOF

Installed.
  app:     $PREFIX
  folders: $WORKSPACES_FILE
  command: chatgpt2codex-start

Next:
  1. List the folders you want:   nano $WORKSPACES_FILE
  2. Start:                       chatgpt2codex-start
  3. See what got indexed:        chatgpt2codex doctor

EOF
