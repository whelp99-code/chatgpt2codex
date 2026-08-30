#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="${APP_NAME:-ChatGPT To Codex}"
BUNDLE_ID="${BUNDLE_ID:-dev.chatgpttocodex.menubar}"
VERSION="$(node -p 'require("./package.json").version')"
BUILD_DIR="$ROOT/build/macos"
APP_DIR="$BUILD_DIR/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/chatgpt2codex"
DEPS_DIR="$BUILD_DIR/deps"
PKG_SCRIPTS_DIR="$BUILD_DIR/pkg-scripts"
UNSIGNED_PKG="$BUILD_DIR/chatgpt2codex-${VERSION}.pkg"
SIGNED_PKG="$BUILD_DIR/chatgpt2codex-${VERSION}-signed.pkg"

find_codesign_identity() {
  local needle="$1"
  security find-identity -v -p codesigning | awk -F '"' -v needle="$needle" '$0 ~ needle { print $2; exit }'
}

find_basic_identity() {
  local needle="$1"
  security find-identity -v | awk -F '"' -v needle="$needle" '$0 ~ needle { print $2; exit }'
}

download_with_cache() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" ]]; then
    return 0
  fi
  curl -fsSL "$url" -o "$out"
}

bundle_node_runtime() {
  if [[ "${CHATGPT2CODEX_BUNDLE_NODE:-1}" == "0" ]]; then
    return 0
  fi
  local node_version node_arch node_dist node_url node_tgz
  node_version="$(node -p 'process.versions.node')"
  case "$(uname -m)" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *) echo "warning: unsupported macOS arch for bundled Node: $(uname -m)" >&2; return 0 ;;
  esac
  node_dist="node-v${node_version}-darwin-${node_arch}"
  node_tgz="$DEPS_DIR/${node_dist}.tar.gz"
  node_url="https://nodejs.org/dist/v${node_version}/${node_dist}.tar.gz"
  mkdir -p "$DEPS_DIR" "$RUNTIME_DIR/bin"
  if [[ ! -d "$DEPS_DIR/$node_dist" ]]; then
    echo "fetching bundled Node.js runtime: $node_url"
    if download_with_cache "$node_url" "$node_tgz"; then
      tar -xzf "$node_tgz" -C "$DEPS_DIR"
    else
      echo "warning: could not fetch Node.js runtime; installed app may need system Node.js 22+." >&2
      return 0
    fi
  fi
  rm -rf "$RUNTIME_DIR/node"
  cp -R "$DEPS_DIR/$node_dist" "$RUNTIME_DIR/node"
  ln -sf "../node/bin/node" "$RUNTIME_DIR/bin/node"
  ln -sf "../node/bin/npm" "$RUNTIME_DIR/bin/npm"
  ln -sf "../node/bin/npx" "$RUNTIME_DIR/bin/npx"
}

bundle_cloudflared() {
  mkdir -p "$RUNTIME_DIR/bin"
  if command -v cloudflared >/dev/null 2>&1; then
    cp "$(command -v cloudflared)" "$RUNTIME_DIR/bin/cloudflared"
    chmod +x "$RUNTIME_DIR/bin/cloudflared"
    return 0
  fi
  if [[ "${CHATGPT2CODEX_BUNDLE_CLOUDFLARED:-1}" == "0" ]]; then
    return 0
  fi
  local cf_arch cf_tgz cf_url cf_dir
  case "$(uname -m)" in
    arm64) cf_arch="arm64" ;;
    x86_64) cf_arch="amd64" ;;
    *) echo "warning: unsupported macOS arch for bundled cloudflared: $(uname -m)" >&2; return 0 ;;
  esac
  cf_dir="$DEPS_DIR/cloudflared-darwin-${cf_arch}"
  cf_tgz="$DEPS_DIR/cloudflared-darwin-${cf_arch}.tgz"
  cf_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${cf_arch}.tgz"
  mkdir -p "$cf_dir"
  echo "fetching bundled cloudflared: $cf_url"
  if download_with_cache "$cf_url" "$cf_tgz"; then
    tar -xzf "$cf_tgz" -C "$cf_dir"
    if [[ -f "$cf_dir/cloudflared" ]]; then
      cp "$cf_dir/cloudflared" "$RUNTIME_DIR/bin/cloudflared"
      chmod +x "$RUNTIME_DIR/bin/cloudflared"
    fi
  else
    echo "warning: could not fetch cloudflared; ChatGPT web connector can install it with Homebrew later." >&2
  fi
}

write_pkg_scripts() {
  rm -rf "$PKG_SCRIPTS_DIR"
  mkdir -p "$PKG_SCRIPTS_DIR"
  cat >"$PKG_SCRIPTS_DIR/postinstall" <<EOF
#!/bin/sh
set -u
APP_RUNTIME="/Applications/${APP_NAME}.app/Contents/Resources/chatgpt2codex"
LOG_DIR="/Users/Shared/ChatGPT To Codex"
LOG_FILE="\$LOG_DIR/install-doctor.log"
mkdir -p "\$LOG_DIR"
if [ -x "\$APP_RUNTIME/macos-dependency-doctor.sh" ]; then
  "\$APP_RUNTIME/macos-dependency-doctor.sh" >"\$LOG_FILE" 2>&1 || true
else
  printf '%s\n' "Doctor script not found at \$APP_RUNTIME/macos-dependency-doctor.sh" >"\$LOG_FILE"
fi
exit 0
EOF
  chmod +x "$PKG_SCRIPTS_DIR/postinstall"
}

APP_SIGN_IDENTITY="${CODESIGN_IDENTITY:-$(find_codesign_identity "Developer ID Application")}"
PKG_SIGN_IDENTITY="${PKG_SIGN_IDENTITY:-$(find_basic_identity "Developer ID Installer")}"

cd "$ROOT"
npm run build
python3 "$ROOT/scripts/generate-macos-icon.py" --out "build/macos/generated-icons"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$RUNTIME_DIR"

cp "$ROOT/macos/ChatGPTToCodexStatusBar/Info.plist" "$CONTENTS_DIR/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$CONTENTS_DIR/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS_DIR/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$CONTENTS_DIR/Info.plist" >/dev/null

swiftc -O \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  "$ROOT/macos/ChatGPTToCodexStatusBar/main.swift" \
  -o "$MACOS_DIR/ChatGPTToCodexStatusBar"

# Native AX semantic-targeting helper for Option B desktop control (see
# src/control/mac-input.ts resolveHelperPath). Lives next to the status-bar
# binary so it inherits the same code signature and Accessibility TCC grant
# (both are covered by the single `codesign --deep` below).
swiftc -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation \
  "$ROOT/macos/ChatGPTToCodexStatusBar/ax-helper.swift" \
  -o "$MACOS_DIR/chatgpt2codex-ax"

cp "$BUILD_DIR/generated-icons/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
cp "$BUILD_DIR/generated-icons/StatusIconTemplate.png" "$RESOURCES_DIR/StatusIconTemplate.png"
cp "$ROOT/assets/chatgpt2codex-icon.png" "$RESOURCES_DIR/chatgpt2codex-icon.png"

cp -R "$ROOT/dist" "$RUNTIME_DIR/dist"
find "$RUNTIME_DIR/dist" -name '*.map' -type f -delete
cp "$ROOT/package.json" "$RUNTIME_DIR/package.json"
cp "$ROOT/package-lock.json" "$RUNTIME_DIR/package-lock.json"
cp "$ROOT/start-chatgpt.sh" "$RUNTIME_DIR/start-chatgpt.sh"
cp "$ROOT/scripts/macos-dependency-doctor.sh" "$RUNTIME_DIR/macos-dependency-doctor.sh"
cp -R "$ROOT/assets" "$RUNTIME_DIR/assets"
mkdir -p "$RUNTIME_DIR/docs"
cp "$ROOT/docs/INSTALL.md" "$RUNTIME_DIR/docs/INSTALL.md"

bundle_node_runtime
bundle_cloudflared

(
  cd "$RUNTIME_DIR"
  env -u npm_config_allow_scripts -u NPM_CONFIG_ALLOW_SCRIPTS \
    npm ci --omit=dev --ignore-scripts --prefer-offline
)
find "$RUNTIME_DIR/node_modules" -name '*.map' -type f -delete
find "$RUNTIME_DIR/node_modules" -name '*.ts' ! -name '*.d.ts' -type f -delete
find "$APP_DIR" -name '._*' -type f -delete

chmod +x "$MACOS_DIR/ChatGPTToCodexStatusBar" "$MACOS_DIR/chatgpt2codex-ax" "$RUNTIME_DIR/start-chatgpt.sh" "$RUNTIME_DIR/macos-dependency-doctor.sh"
write_pkg_scripts
xattr -cr "$APP_DIR" || true

if [[ -n "$APP_SIGN_IDENTITY" ]]; then
  codesign --force --deep --options runtime --timestamp --sign "$APP_SIGN_IDENTITY" "$APP_DIR"
else
  codesign --force --deep --sign - "$APP_DIR"
fi

codesign --verify --deep --strict --verbose=2 "$APP_DIR"

rm -f "$UNSIGNED_PKG" "$SIGNED_PKG"
pkgbuild --component "$APP_DIR" --install-location /Applications --scripts "$PKG_SCRIPTS_DIR" "$UNSIGNED_PKG"

if [[ -n "$PKG_SIGN_IDENTITY" ]]; then
  productsign --sign "$PKG_SIGN_IDENTITY" "$UNSIGNED_PKG" "$SIGNED_PKG"
  pkgutil --check-signature "$SIGNED_PKG"
  if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    xcrun notarytool submit "$SIGNED_PKG" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
    xcrun stapler staple "$SIGNED_PKG"
    spctl -a -vv --type install "$SIGNED_PKG"
  fi
  echo "$SIGNED_PKG"
else
  echo "warning: Developer ID Installer identity not found; pkg is unsigned but contains a signed app." >&2
  pkgutil --check-signature "$UNSIGNED_PKG" || true
  echo "$UNSIGNED_PKG"
fi
