[CmdletBinding()]
param(
  [string]$OutputRun = "",
  [string]$NodeVersion = "",
  [switch]$SkipRipgrep
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BuildRoot = Join-Path $Root "build\linux"
$PackageDir = Join-Path $BuildRoot "chatgpt2codex-linux-x64"
if (-not $OutputRun -or $OutputRun.Trim().Length -eq 0) {
  $OutputRun = Join-Path $BuildRoot "chatgpt2codex-linux-x64.run"
}
$OutputRun = [System.IO.Path]::GetFullPath($OutputRun)

function Assert-UnderPath([string]$PathToCheck, [string]$ParentPath) {
  $fullChild = [System.IO.Path]::GetFullPath($PathToCheck).TrimEnd('\')
  $fullParent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd('\')
  if (-not $fullChild.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside build root: $fullChild"
  }
}

function Get-ToolPath([string[]]$Names) {
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
  }
  throw "Missing required command: $($Names -join ' or ')"
}

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList) {
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $FilePath $($ArgumentList -join ' ')"
  }
}

function Copy-Tree([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Source) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
  }
}

function Download-File([string]$Url, [string]$Destination) {
  $Curl = Get-ToolPath @("curl.exe", "curl")
  Invoke-Checked $Curl @("-L", "--fail", "--retry", "3", "--connect-timeout", "20", "--max-time", "300", "-o", $Destination, $Url)
}

New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
Assert-UnderPath $PackageDir $BuildRoot

$Npm = Get-ToolPath @("npm.cmd", "npm")
$Tar = Get-ToolPath @("tar.exe", "tar")

function Invoke-Npm([string[]]$Arguments) {
  $saved = @{}
  foreach ($name in @("NPM_CONFIG_ALLOW_SCRIPTS", "npm_config_allow_scripts")) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $saved[$name] = $value }
    [Environment]::SetEnvironmentVariable($name, $null)
  }
  try {
    Invoke-Checked $Npm $Arguments
  } finally {
    foreach ($entry in $saved.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value)
    }
  }
}

Write-Host "[chatgpt2codex] installing dependencies..."
Invoke-Npm @("install")
Write-Host "[chatgpt2codex] building TypeScript..."
Invoke-Npm @("run", "build")

if (Test-Path -LiteralPath $PackageDir) {
  Remove-Item -LiteralPath $PackageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PackageDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackageDir "bin") -Force | Out-Null

Copy-Tree (Join-Path $Root "dist") (Join-Path $PackageDir "dist")
Copy-Tree (Join-Path $Root "browser") (Join-Path $PackageDir "browser")
Copy-Tree (Join-Path $Root "assets") (Join-Path $PackageDir "assets")

foreach ($file in @("package.json", "package-lock.json", "README.md")) {
  Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $PackageDir $file) -Force
}
Copy-Item -LiteralPath (Join-Path $Root "linux\chatgpt2codex") -Destination (Join-Path $PackageDir "chatgpt2codex") -Force
Copy-Item -LiteralPath (Join-Path $Root "linux\start-chatgpt2codex.sh") -Destination (Join-Path $PackageDir "start-chatgpt2codex.sh") -Force
Copy-Item -LiteralPath (Join-Path $Root "linux\install-linux.sh") -Destination (Join-Path $PackageDir "install-linux.sh") -Force

Push-Location $PackageDir
try {
  Invoke-Npm @("ci", "--omit=dev", "--ignore-scripts")
} finally {
  Pop-Location
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("chatgpt2codex-linux-build-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
try {
  if (-not $NodeVersion -or $NodeVersion.Trim().Length -eq 0) {
    $NodeVersion = (& node -p "process.version").Trim()
    if ($NodeVersion.StartsWith("v")) { $NodeVersion = $NodeVersion.Substring(1) }
  }
  $NodeArchive = Join-Path $TempDir "node-linux-x64.tar.xz"
  $NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-linux-x64.tar.xz"
  Write-Host "[chatgpt2codex] downloading Linux Node.js $NodeVersion..."
  Download-File $NodeUrl $NodeArchive
  Invoke-Checked $Tar @("-xf", $NodeArchive, "-C", $TempDir)
  $NodeBin = Join-Path $TempDir "node-v$NodeVersion-linux-x64\bin\node"
  if (-not (Test-Path -LiteralPath $NodeBin)) { throw "Linux node binary was not found after extraction." }
  Copy-Item -LiteralPath $NodeBin -Destination (Join-Path $PackageDir "bin\node") -Force

  $Cloudflared = Join-Path $PackageDir "bin\cloudflared"
  Write-Host "[chatgpt2codex] downloading Linux cloudflared..."
  Download-File "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" $Cloudflared

  if (-not $SkipRipgrep) {
    try {
      $RgVersion = "15.1.0"
      $RgArchive = Join-Path $TempDir "ripgrep-linux.tar.gz"
      $RgUrl = "https://github.com/BurntSushi/ripgrep/releases/download/$RgVersion/ripgrep-$RgVersion-x86_64-unknown-linux-musl.tar.gz"
      Write-Host "[chatgpt2codex] downloading Linux ripgrep $RgVersion..."
      Download-File $RgUrl $RgArchive
      Invoke-Checked $Tar @("-xzf", $RgArchive, "-C", $TempDir)
      $RgBin = Join-Path $TempDir "ripgrep-$RgVersion-x86_64-unknown-linux-musl\rg"
      if (Test-Path -LiteralPath $RgBin) {
        Copy-Item -LiteralPath $RgBin -Destination (Join-Path $PackageDir "bin\rg") -Force
      }
    } catch {
      Write-Warning "Could not bundle Linux rg: $($_.Exception.Message). Code search will use the JavaScript fallback if rg is absent."
    }
  }
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$Payload = Join-Path $BuildRoot "payload-linux-x64.tar.gz"
if (Test-Path -LiteralPath $Payload) { Remove-Item -LiteralPath $Payload -Force }
Push-Location $PackageDir
try {
  $TarArgs = @("-czf", $Payload, ".")
  if ($IsMacOS) {
    $TarArgs = @("--no-xattrs", "-czf", $Payload, ".")
  }
  Invoke-Checked $Tar $TarArgs
} finally {
  Pop-Location
}

$Header = @'
#!/usr/bin/env bash
set -Eeuo pipefail

PREFIX=""
LAUNCH=1
INSTALL_SYSTEMD=0
USER_SYSTEMD=0
WORKSPACE="${WORKSPACE:-$HOME/workspace}"
PORT="${PORT:-7979}"

usage() {
  cat <<'EOF'
Usage: chatgpt2codex-linux-x64.run [options]

Options:
  --prefix PATH       Install path. Default: /opt/chatgpt2codex as root, otherwise ~/.local/share/chatgpt2codex-app
  --no-launch         Install only
  --launch            Install and start in the foreground (default)
  --systemd           Install and start a system service (root)
  --user-systemd      Install and start a user systemd service
  --workspace PATH    Workspace used when launching. Default: ~/workspace
  --port PORT         Local port. Default: 7979
  -h, --help          Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      PREFIX="${2:?--prefix requires a value}"
      shift 2
      ;;
    --no-launch)
      LAUNCH=0
      shift
      ;;
    --launch)
      LAUNCH=1
      shift
      ;;
    --systemd)
      INSTALL_SYSTEMD=1
      LAUNCH=0
      shift
      ;;
    --user-systemd)
      USER_SYSTEMD=1
      LAUNCH=0
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

tmp="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt2codex-run.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

archive_line="$(awk '/^__CHATGPT2CODEX_PAYLOAD_BELOW__$/ { print NR + 1; exit 0; }' "$0")"
if [ -z "$archive_line" ]; then
  echo "installer payload marker not found" >&2
  exit 1
fi

tail -n +"$archive_line" "$0" | tar -xzf - -C "$tmp"
install_args=(--prefix "$PREFIX" --no-launch --workspace "$WORKSPACE" --port "$PORT")
[ "$INSTALL_SYSTEMD" -eq 1 ] && install_args+=(--systemd)
[ "$USER_SYSTEMD" -eq 1 ] && install_args+=(--user-systemd)
bash "$tmp/install-linux.sh" "${install_args[@]}"

if [ "$LAUNCH" -eq 1 ]; then
  trap - EXIT
  cleanup
  exec "$PREFIX/start-chatgpt2codex.sh" --workspace "$WORKSPACE" --port "$PORT"
fi

exit 0
__CHATGPT2CODEX_PAYLOAD_BELOW__
'@

if (Test-Path -LiteralPath $OutputRun) { Remove-Item -LiteralPath $OutputRun -Force }
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$HeaderText = $Header.Replace("`r`n", "`n")
if (-not $HeaderText.EndsWith("`n")) {
  $HeaderText += "`n"
}
[System.IO.File]::WriteAllText($OutputRun, $HeaderText, $Utf8NoBom)
$PayloadBytes = [System.IO.File]::ReadAllBytes($Payload)
$Stream = [System.IO.File]::Open($OutputRun, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
try {
  $Stream.Write($PayloadBytes, 0, $PayloadBytes.Length)
} finally {
  $Stream.Close()
}

Write-Host ""
Write-Host "Linux installer ready:"
Write-Host "  $OutputRun"
Write-Host "Run on a Linux VPS:"
Write-Host "  bash chatgpt2codex-linux-x64.run"
