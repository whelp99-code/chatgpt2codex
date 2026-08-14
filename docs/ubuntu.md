# Running chatgpt2codex on Ubuntu

Tested on Ubuntu 26.04 LTS with the Node 22 that ships in the default
repository. Nothing outside `apt` is required.

## What works, and what does not

The MCP server, multi-folder project indexing, code editing, git, command
execution, OAuth, and Cloudflare tunnels all behave exactly as they do on
macOS.

Three macOS-only features are unavailable. Desktop control (synthetic input via
the Accessibility API) and `screencapture`-based E2E screenshots are bound to
macOS system APIs and return `NOT_IMPLEMENTED` when called on Linux. There is
also no status-bar app, so starting, stopping, and diagnostics happen through
the command line or a systemd unit.

## Install

```bash
git clone https://github.com/whelp99-code/chatgpt2codex.git
cd chatgpt2codex
bash linux/install-ubuntu.sh
```

The installer builds from source when `dist/` is absent, installs to
`~/.local/share/chatgpt2codex-app`, and links `chatgpt2codex` and
`chatgpt2codex-start` into `~/.local/bin`.

Add `--service` to also register a `systemd --user` unit that starts the
bridge on login.

If the installer reports that `~/.local/bin` is not on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

## Registering folders

Workspace roots live one per line in
`~/.local/share/chatgpt2codex/workspaces.txt`. Every git repository directly
inside a root becomes a project, `~` is expanded, and `#` starts a comment.
There is no limit on the number of roots.

```
# my project folders
~/Projects
~/work/clients
/mnt/data/repos
```

Set `CHATGPT2CODEX_WORKSPACES` to a newline-separated list to override the file
entirely, or `CHATGPT2CODEX_WORKSPACES_FILE` to read it from another path. When
neither is present the single-root `WORKSPACE` variable still applies, so older
configurations keep working.

## Start

```bash
chatgpt2codex-start
```

The startup banner lists every configured root before the connector URL, and
marks any root it cannot read with `[UNREADABLE]`. Pass `--no-tunnel` to stay on
`127.0.0.1`.

Under systemd:

```bash
systemctl --user start chatgpt2codex
systemctl --user status chatgpt2codex
sudo loginctl enable-linger "$USER"   # keep running after logout
```

## Verify

```bash
chatgpt2codex doctor
```

```
workspace roots (3):
  - /home/you/Projects        (2 project(s))
  - /home/you/work/clients    (1 project(s))
  - /mnt/data/repos           (1 project(s))
projects indexed: 4
```

A root showing `0 project(s)` usually means a typo in the path. Roots are
created when missing rather than reported as an error, so a mistyped path
shows up as an empty folder instead of a failure.

## Running alongside a macOS instance

Both machines can serve at once, but they need separate Cloudflare tunnels.
Running one named tunnel from two hosts makes Cloudflare treat them as replicas
of the same tunnel and split requests between them at random, so calls land on
whichever filesystem wins the coin flip.

Create a second tunnel and hostname for the Ubuntu box:

```bash
cloudflared tunnel login
cloudflared tunnel create chatgpt2codex-ubuntu
cloudflared tunnel route dns chatgpt2codex-ubuntu mcp2.example.com
```

Then start against it:

```bash
CLOUDFLARED_TUNNEL_NAME=chatgpt2codex-ubuntu \
PUBLIC_HOSTNAME=mcp2.example.com \
chatgpt2codex-start
```

Register that hostname in ChatGPT as an additional connector. Each machine
keeps its own state directory and owner token, which is the intended
arrangement. Because both connectors expose identically named tools, give them
clearly distinct names and prefer enabling one at a time.

To move an existing connector to Ubuntu instead of adding a second one, copy
`~/.cloudflared/` and the `owner-token.json` and `oauth.json` files from
`~/.local/share/chatgpt2codex/` across, fix the `credentials-file` path in the
tunnel config, and stop the macOS instance. The URL and the ChatGPT
registration then carry over untouched. Do not copy `projects.json`; its paths
are machine-specific and it is rebuilt on start.

## Note on install-linux.sh

`linux/install-linux.sh` targets the prebuilt `.run` bundle produced by
`scripts/build-linux-installer.ps1`. Use `install-ubuntu.sh` for a source
checkout: the older script links `chatgpt2codex` to the install root while
leaving the executables under `linux/`, so the symlinks it creates do not
resolve, and its `pgrep -f "$PREFIX"` shutdown step also matches and kills
unrelated processes whose command line mentions the install path, including the
shell that invoked it.
