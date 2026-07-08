# Sandboxed Agent PoC

An Electron desktop proof-of-concept: a Claude-powered agent that works on
**in-memory copies** of user-staged files through a locked-down toolset.
Everything runs locally except the LLM API call, and agent-visible file content
never touches disk.

**Download:** [latest release (portable Windows .exe)](https://github.com/X4vier/sandboxed-agent-poc/releases/latest)

## Setup

Requires Node 22.13+ and npm. No compiler toolchain is needed: the dependency
tree contains no native modules that compile on install. PDF.js may install
`@napi-rs/canvas` as an optional dependency; it ships prebuilt binaries and is
only used by PDF.js rendering paths, not by the app's text extraction path.

```bash
npm install
cp .env.example .env   # then edit
```

The Anthropic API key is **entered in the app at startup**, held in memory for
the session only, and never written to disk. There is nothing to configure for
it — just launch the app and paste the key when prompted. Use the **🔑 Change
key** button in the header to replace it during a session.

Environment variables (all optional):

| Variable            | Default             | Purpose                                                        |
| ------------------- | ------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | —                   | Dev convenience: seeds the session key so you skip the prompt. |
| `AGENT_MODEL`       | `claude-sonnet-5`   | Model id.                                                      |
| `AGENT_CONTEXT_WINDOW` | `200000`         | Model context window; each agent compacts before filling it.  |
| `AGENT_COMPACT_THRESHOLD` | `0.8`         | Fraction of the window at which an agent compacts its history. |

## Run

```bash
npm run dev        # launch the app (electron-vite)
npm run build      # production build to out/
npm run typecheck  # strict tsc, no emit
npm test           # vitest (validator, workspace, tools, QuickJS, loop)
```

## Debugging

Set `AGENT_DEBUG_LOG` to a directory path before launching the app to write an
opt-in JSONL debug log for each task run:

```bash
AGENT_DEBUG_LOG=/tmp/agent-debug npm run dev
```

This deliberately breaches the normal no-disk-residue guarantee. It logs agent
events, tool inputs, truncated tool results, and run start/end metadata to disk,
so do **not** use it with sensitive documents. When active, the app shows a
red debug-log badge with a **Stop logging** button that disables logging for the
rest of the session.

### Package a portable Windows .exe

```bash
npm run build:win  # -> release/Sandboxed Agent PoC-<version>-portable.exe
```

Run this **on Windows** (PowerShell or cmd), not under WSL — electron-builder
produces a native Windows binary. It compiles with `electron-vite build`, then
packs `out/` plus production dependencies into a single self-contained `.exe`
(no install step) via `electron-builder` (config in `electron-builder.yml`).
Since the API key is entered at runtime, the packaged exe ships **no secrets**.

If you develop in **WSL**, don't run `build:win` against your Linux checkout —
its `node_modules` may hold Linux-native optional dependencies. Instead use:

```bash
npm run build:win:wsl           # sync -> Windows install -> build
npm run build:win:wsl -- --run  # ...then launch the exe
```

This drives the Windows Node toolchain over WSL interop in an isolated
Windows-side working copy (its own `node_modules`), so your Linux `node_modules`
is never touched. The exe is copied back into `release/`. Requires Node on
Windows and WSL interop (`cmd.exe` on PATH). See `scripts/build-win.sh`.

On launch the app prompts for your Anthropic API key (unless `ANTHROPIC_API_KEY`
is set in the environment `npm run dev` inherits, in which case it is used as a
seed). The key stays in main-process memory and is discarded when the app exits.

## Architecture

```
Renderer (UI) ── IPC (contextBridge) ── Main process
                                          ├─ runAgent() loop (@anthropic-ai/sdk)
                                          ├─ Tool registry
                                          │    ├─ file tools ──► VirtualWorkspace
                                          │    └─ run_javascript ──► QuickJS-WASM guest
                                          └─ VirtualWorkspace (in-memory, per task)
```

- **Renderer** is fully sandboxed (`contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`) and talks to the main process only through the
  narrow `window.agent` bridge defined in `src/preload`.
- **Agent loop** (`src/main/agent/loop.ts`) is a hand-written Messages-API tool
  loop: stream assistant text, execute `tool_use` blocks, append `tool_result`
  blocks, repeat. All state flows through `AgentRunOptions`, so a subagent is
  just a recursive `runAgent` call sharing the same VFS. Runs are never aborted
  on a token count; instead each agent watches how full its own context window
  is (the latest turn's `input_tokens`) and compacts its history — summarizing
  older turns into a single message — before the window overflows.
- **VirtualWorkspace** (`src/main/workspace`) is a `Map`-backed VFS keyed by
  normalized POSIX-relative paths, tracking `provided | created | modified`.
  A seed corpus (~100 country .docx/.pdf files in `seed-data/`) is pre-staged
  into the VFS on launch.
- **Tools** (`src/main/tools`): `Read`, `Write`, `Edit`, `Glob`, `Grep`,
  `list_files`, `read_document`, `run_javascript`, `Task` (spawns a subagent
  sharing the same VFS, max depth 2), and `TodoWrite`. Names and parameter shapes
  mirror Claude Code's bash-flavored tool API (`cat -n` reads, regex Grep, glob
  matching) so the model hits fewer malformed calls; paths remain
  workspace-relative rather than absolute. Each reaches the OS only through an
  injected `ToolContext`.
- **Path validator** (`src/main/workspace/normalizePath.ts`) is used by every
  VFS operation and every guest-injected file function.
- **Client** (`src/main/agent/client.ts`) is the only place the SDK client is
  constructed — swap in Bedrock by changing this one file.

## Security & privacy model

**Guarantees**

- **Nothing to wipe, even on hard kill.** Agent-visible files exist only in RAM
  in the `VirtualWorkspace`. Staged originals are read once, read-only; their
  content lives only in memory thereafter. The only code paths that write
  workspace content to disk are the two user-initiated export handlers in
  `src/main/ipc.ts` (`exportFile`, `exportAll`). There is no temp-file spill, no
  on-disk cache, no debug dump.
- **Ephemeral API key.** The key is entered in the UI and held only in a
  main-process variable (`src/main/agent/client.ts`). It is never persisted, never
  sent back to the renderer (which can only set, clear, or check its presence),
  and is gone when the process exits.
- **Zero network, zero shell.** The agent has no HTTP/fetch tool, no bash, no
  shell of any kind. The only network traffic in the app is the Messages API
  call from the main process.
- **Capability-based code sandbox.** `run_javascript` executes in a fresh
  QuickJS (WASM) runtime per call with a 256MB memory limit and a 30s interrupt
  deadline. The guest has no `require`, `import`, `fetch`, `process`, timers, or
  `console` — only the injected `readFile`/`writeFile`/`listFiles`/`log`
  functions, each routed through the path validator into the same in-memory VFS.
- **Path safety.** Every path is validated: escaping (`..`), absolute, drive,
  and UNC forms, null bytes, Windows device names, and NTFS stream forms are all
  rejected before a key is created. Exported filenames are additionally
  sanitized.

**Honest limits**

- **Prompt injection is not solved.** File _contents_ are untrusted; a staged
  file can contain instructions that steer the agent into mangling workspace
  contents. Review results before exporting.
- **RAM-bounded.** The workspace is capped at ~50MB/file and ~500MB total; it is
  not a durable store.
- **"Local-only" means local _residue_, not end-to-end secrecy.** File contents
  are sent to the Anthropic API as context to do the work. Local-only refers to
  the absence of on-disk residue and the lack of any other network egress, not
  to confidentiality from the LLM provider.

## Tests

`npm test` covers the security-critical surface: the path validator (every case
in the spec), the VirtualWorkspace (status transitions, caps, binary detection),
the file/document tools, the Task subagent and todo tools, the QuickJS
capability sandbox (no ambient globals, validator
enforcement in-guest, infinite-loop interruption), and the agent loop (tool
execution, `is_error` handling, cancellation) against a mocked client — no
network required.

> Live end-to-end runs (staging a real CSV, streaming a summary, exporting)
> require a valid `ANTHROPIC_API_KEY` and are driven interactively via
> `npm run dev`.
