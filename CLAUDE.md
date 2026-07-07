# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron PoC ("Sandboxed Agent PoC") of a Claude-powered agent that operates on **in-memory copies** of user-staged files through a locked-down toolset. The core invariant: agent-visible file content never touches disk (RAM-only `VirtualWorkspace`; the only disk writes are the user-initiated export handlers in `src/main/ipc.ts`), there is no shell/network tool, and the API key is entered at runtime and held only in main-process memory. Preserve these properties in any change — don't add temp files, on-disk caches, key persistence, or new network egress.

## Commands

```bash
npm run dev          # launch the app (electron-vite); reads .env, prompts for API key otherwise
npm test             # vitest, no network needed (agent loop tests use a mocked client)
npx vitest run tests/loop.test.ts        # single test file
npm run typecheck    # strict tsc --noEmit
npm run build:win    # portable Windows .exe (run on Windows)
npm run build:win:wsl   # from WSL: syncs to a Windows-side working copy and builds there
```

WSL note: never run `build:win` against the Linux checkout — its `node_modules` is Linux-native. Use the `:wsl` variants (`scripts/build-win.sh`, `scripts/dev-win.sh`).

Live end-to-end behavior can only be exercised interactively via `npm run dev` with a real `ANTHROPIC_API_KEY`.

## Architecture

Renderer ↔ main is a narrow `contextBridge` API (`window.agent`) defined in `src/preload`; the shared IPC channel/type contract lives in `src/shared/ipc.ts` — change it there first, then preload, main handler (`src/main/ipc.ts`), and renderer. The renderer (`src/renderer`, plain TS, no framework) is fully sandboxed.

Main-process pieces:

- **Agent loop** (`src/main/agent/loop.ts`): hand-written Messages-API tool loop. All state flows through `AgentRunOptions`; a subagent (the `Task` tool, `src/main/tools/task.ts`, max depth 2) is just a recursive `runAgent` call sharing the same VFS. Instead of aborting on token counts, each agent compacts its own history (summarizing older turns) when the latest turn's `input_tokens` crosses `AGENT_COMPACT_THRESHOLD` of the window.
- **Client** (`src/main/agent/client.ts`): the only place the SDK client is constructed and the only place the API key lives.
- **VirtualWorkspace** (`src/main/workspace/VirtualWorkspace.ts`): Map-backed VFS keyed by normalized POSIX-relative paths, tracking `provided | created | modified`. Caps: ~50MB/file, ~500MB total.
- **Path validator** (`src/main/workspace/normalizePath.ts`): security-critical; every VFS operation and every QuickJS guest file function goes through it. Rejects `..`, absolute/drive/UNC paths, null bytes, Windows device names, NTFS streams.
- **Tools** (`src/main/tools/`, wired in `registry.ts`): Read/Write/Edit/Glob/Grep/list_files/read_document/run_javascript/Task/todos. Names and parameter shapes deliberately mirror Claude Code's own tool API (e.g. `cat -n`-style reads) so the model makes fewer malformed calls; paths are workspace-relative. Tools reach the outside world only through the injected `ToolContext`.
- **run_javascript** (`src/main/tools/runJavascript.ts`): fresh QuickJS-WASM runtime per call, 256MB / 30s limits, no ambient globals — only injected `readFile`/`writeFile`/`listFiles`/`log`, all path-validated.
- **Document extraction** (`src/main/documents/`): `ExtractorRegistry` maps extensions → extractors (pdf, docx). New file type = one extractor under `extractors/` + one `.register()` in `index.ts`. Text-style documents use `window.ts` for line and character bounds; PDFs are sliced by page range and attached natively.
- **Seed corpus** (`src/main/workspace/seedCorpus.ts`): ~100 country .docx/.pdf files in `seed-data/` are pre-staged into the VFS on launch (bundled via electron-builder `extraResources` in production). Generated/verified by `scripts/seed/`.

## Notes

- File *contents* are untrusted (prompt injection is an acknowledged, unsolved limit); "local-only" means no on-disk residue, not confidentiality from the LLM provider.
- Tests cover the security surface (validator, workspace, tools, QuickJS sandbox, loop); changes to any of those should extend the corresponding `tests/*.test.ts`.
