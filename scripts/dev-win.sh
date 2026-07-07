#!/usr/bin/env bash
#
# Run the dev loop against the *Windows* Electron binary *from WSL*.
#
# `npm run dev` in WSL launches the Linux Electron (rendered via WSLg). To
# exercise the real win32 binary with live reload, the whole electron-vite dev
# toolchain has to run on the Windows side — cmd.exe can't cd into this ext4
# checkout's \\wsl.localhost path, so (exactly like build-win.sh) we sync the
# tree into an isolated dir under the Windows profile, which has its own win32
# node_modules, and run `npm run dev` there via interop.
#
# The isolated dir is shared with build:win:wsl, so its node_modules install
# serves both flows.
#
# Usage:
#   npm run dev:win:wsl              # sync once -> Windows `npm run dev`
#   npm run dev:win:wsl -- --watch   # ...and keep re-syncing on file changes
#                                    #    so edits in your WSL checkout reload
#   npm run dev:win:wsl -- --clean   # wipe the isolated node_modules first
set -euo pipefail

WATCH=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --clean) CLEAN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- preconditions --------------------------------------------------------
grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null \
  || { echo "Must run under WSL (needs Windows interop)." >&2; exit 1; }
command -v cmd.exe >/dev/null \
  || { echo "cmd.exe not on PATH — WSL interop is disabled." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Isolated Windows-side dir (shared with build:win:wsl), under the Windows user
# profile so it lives on the Windows filesystem with its own (win32) node_modules.
WIN_HOME_WIN="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
ISO_WSL="$(wslpath -u "$WIN_HOME_WIN")/.sandboxed-agent-win-build"
mkdir -p "$ISO_WSL"

if [ "$CLEAN" = 1 ]; then
  echo "Cleaning isolated node_modules…"
  rm -rf "$ISO_WSL/node_modules" "$ISO_WSL/out" "$ISO_WSL/release"
fi

# Source-only sync. Excluded paths are preserved in the dest, so the isolated
# node_modules / out survive and installs stay incremental. .env is excluded so
# no key crosses over — paste your key in the app's key gate (dev holds it in
# memory only), or copy .env into the isolated dir yourself if you prefer.
SYNC_EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude 'out' --exclude 'release'
  --exclude '.env' --exclude '.env.local' --exclude 'seed-review'
)
sync_once() { rsync -a --delete "${SYNC_EXCLUDES[@]}" "$REPO_ROOT/" "$ISO_WSL/"; }

echo "Syncing source -> $ISO_WSL"
sync_once

# --- ensure win32 dependencies -------------------------------------------
# Install when node_modules is missing (build:win:wsl / a prior run may have
# populated it already).
if [ ! -d "$ISO_WSL/node_modules" ]; then
  echo "Installing win32 node_modules (first run)…"
  ( cd "$ISO_WSL" && cmd.exe /c "npm install --no-fund --no-audit" ) \
    || { echo "Windows npm install failed." >&2; exit 1; }
fi

# `npm run dev` launches Electron, so the electron *binary* must be present —
# not just the package. build:win only needs electron-builder (which fetches
# its own copy), so a build-populated node_modules can lack dist/electron.exe,
# which makes electron-vite throw "Electron uninstall". Fetch it by running
# electron's downloader directly: `npm rebuild` is a no-op when the npm config
# blocks install scripts (ignore-scripts / allow-scripts), but invoking
# install.js with node bypasses that gate.
if [ ! -f "$ISO_WSL/node_modules/electron/dist/electron.exe" ]; then
  echo "Electron binary missing — downloading it (electron/install.js)…"
  ( cd "$ISO_WSL" && cmd.exe /c "node node_modules\\electron\\install.js" ) \
    || { echo "Failed to download the Electron binary." >&2; exit 1; }
fi

# --- optional live re-sync while dev runs ---------------------------------
# A cheap 1s polling loop (rsync only ships changed files); no inotify dep.
if [ "$WATCH" = 1 ]; then
  ( while true; do sync_once >/dev/null 2>&1 || true; sleep 1; done ) &
  SYNC_PID=$!
  trap 'kill "$SYNC_PID" 2>/dev/null || true' EXIT INT TERM
  echo "Watching for changes (edits in this checkout will re-sync + reload)."
fi

# --- run the Windows dev server + Electron --------------------------------
# Foreground; the isolated dir lives under /mnt/c so cmd.exe gets a valid C:\
# CWD and needs no `cd /d`. Ctrl-C stops the watcher (trap); close the Electron
# window to end the dev server.
echo "Starting Windows dev (electron-vite) in $(wslpath -w "$ISO_WSL")"
( cd "$ISO_WSL" && cmd.exe /c "npm run dev" )
