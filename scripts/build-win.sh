#!/usr/bin/env bash
#
# Build (and optionally launch) the portable Windows .exe *from WSL*, without
# ever touching this checkout's Linux node_modules.
#
# WSL cannot produce a Windows binary itself, but it can drive the Windows Node
# toolchain over WSL interop. So we sync the working tree into an isolated
# Windows-side directory (its OWN node_modules) and run `pnpm install` +
# `pnpm run build:win` there via cmd.exe. Your Linux node_modules stays intact.
# pnpm is invoked through corepack (ships with Node), pinned by the
# `packageManager` field in package.json — no Windows-side pnpm install needed.
#
# Usage:
#   pnpm run build:win:wsl            # sync -> Windows install -> build
#   pnpm run build:win:wsl -- --run   # ...then launch the exe on Windows
#   pnpm run build:win:wsl -- --clean # wipe the isolated node_modules first
set -euo pipefail

RUN_AFTER=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --run) RUN_AFTER=1 ;;
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
cmd.exe /c "corepack --version" >/dev/null 2>&1 \
  || { echo "corepack not found on the Windows Node install (needed to run pnpm)." >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Isolated Windows-side build dir, under the Windows user profile so it lives on
# the Windows filesystem and keeps its own (win32) node_modules across runs.
WIN_HOME_WIN="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
ISO_WSL="$(wslpath -u "$WIN_HOME_WIN")/.sandboxed-agent-win-build"
mkdir -p "$ISO_WSL"

if [ "$CLEAN" = 1 ]; then
  echo "Cleaning isolated node_modules…"
  rm -rf "$ISO_WSL/node_modules" "$ISO_WSL/out" "$ISO_WSL/release"
fi

# --- sync source (never node_modules/out/release/.git) --------------------
# --delete keeps the copy exact; excluded paths are preserved in the dest, so
# the isolated node_modules survives and installs stay incremental.
echo "Syncing source -> $ISO_WSL"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'out' \
  --exclude 'release' \
  --exclude '.env' \
  --exclude '.env.local' \
  "$REPO_ROOT/" "$ISO_WSL/"

# --- install + build on Windows via interop -------------------------------
# cmd.exe cannot use this ext4 checkout's \\wsl.localhost\... path as its CWD,
# and when launched with a UNC CWD its `cd /d` is broken (fails even for
# C:\Windows). So we enter the isolated dir *in bash* first — it lives under
# /mnt/c, so cmd.exe then inherits a proper C:\ CWD and no `cd /d` is needed.
# The subshell keeps this CWD change from leaking into artifact collection.
ISO_WIN="$(wslpath -w "$ISO_WSL")"
echo "Running Windows pnpm install + build:win in $ISO_WIN"
# pnpm must be a real command on PATH, not just `corepack pnpm`: electron-builder
# detects pm=pnpm from the lockfile and spawns `pnpm ls --json` itself while
# collecting production node_modules. `corepack enable` materializes a pnpm shim
# into a user-writable dir (the default target is Program Files, which needs
# admin) that we prepend to PATH. COREPACK_ENABLE_DOWNLOAD_PROMPT=0 skips
# corepack's interactive "download pnpm@x.y.z?" prompt on first use.
SHIMS='%USERPROFILE%\.corepack-shims'
( cd "$ISO_WSL" && cmd.exe /c "set COREPACK_ENABLE_DOWNLOAD_PROMPT=0&& (if not exist $SHIMS mkdir $SHIMS) && corepack enable --install-directory $SHIMS pnpm && set PATH=$SHIMS;%PATH%&& pnpm install && pnpm run build:win" ) \
  || { echo "Windows build failed." >&2; exit 1; }

# --- collect the artifact -------------------------------------------------
mkdir -p "$REPO_ROOT/release"
shopt -s nullglob
exes=("$ISO_WSL"/release/*portable.exe)
shopt -u nullglob
if [ ${#exes[@]} -eq 0 ]; then
  echo "Build finished but no *portable.exe found in $ISO_WSL/release." >&2
  exit 1
fi
cp "${exes[@]}" "$REPO_ROOT/release/"

exe_wsl="$REPO_ROOT/release/$(basename "${exes[0]}")"
exe_win="$(wslpath -w "$exe_wsl")"
size="$(du -h "$exe_wsl" | cut -f1)"
echo ""
echo "✔ Portable exe ready ($size)"
echo "  WSL path:     $exe_wsl"
echo "  Windows path: $exe_win"

if [ "$RUN_AFTER" = 1 ]; then
  echo "Launching on Windows…"
  cmd.exe /c start "" "$exe_win"
fi
