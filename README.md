# Sandboxed Agent PoC

An Electron desktop proof-of-concept: a Claude-powered agent that works on
**in-memory copies** of user-staged files through a locked-down toolset.
Everything runs locally except the LLM API call, and agent-visible file content
never touches disk.

## Setup

Requires Node 20+ and npm. No compiler toolchain is needed — the dependency
tree contains no native modules that build on install.

```bash
npm install
cp .env.example .env   # then edit
```

Environment variables:

| Variable            | Required | Default             | Purpose                                   |
| ------------------- | -------- | ------------------- | ----------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | —                   | Auth for the Messages API (PoC).          |
| `AGENT_MODEL`       | no       | `claude-sonnet-4-6` | Model id.                                 |
| `AGENT_TOKEN_BUDGET`| no       | `500000`            | Cumulative token ceiling per run.         |

## Run

```bash
npm run dev        # launch the app (electron-vite)
npm run build      # production build to out/
npm run typecheck  # strict tsc, no emit
npm test           # vitest (validator, workspace, tools, QuickJS, loop)
```

`ANTHROPIC_API_KEY` must be set in the environment `npm run dev` inherits.

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
  blocks, repeat. All state flows through `AgentRunOptions`, so a future
  `spawn_subagent` tool is just a recursive `runAgent` call sharing the same VFS
  and token budget.
- **VirtualWorkspace** (`src/main/workspace`) is a `Map`-backed VFS keyed by
  normalized POSIX-relative paths, tracking `provided | created | modified`.
- **Tools** (`src/main/tools`): `read_file`, `write_file`, `edit_file`,
  `list_files`, `search_files`, `run_javascript`. Each reaches the OS only
  through an injected `ToolContext`.
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
the six tools, the QuickJS capability sandbox (no ambient globals, validator
enforcement in-guest, infinite-loop interruption), and the agent loop (tool
execution, `is_error` handling, cancellation) against a mocked client — no
network required.

> Live end-to-end runs (staging a real CSV, streaming a summary, exporting)
> require a valid `ANTHROPIC_API_KEY` and are driven interactively via
> `npm run dev`.
