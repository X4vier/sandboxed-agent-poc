Prompt for Claude Code

Build a proof-of-concept Electron desktop app containing a sandboxed AI agent. The user stages some files, types a task, and a Claude-powered agent works on in-memory copies of those files using a locked-down toolset. Everything runs locally except the LLM API calls, and agent-visible files never touch disk.

Read this whole document before writing code. The security and privacy constraints are the point of the PoC — do not trade them away for convenience, and ask me rather than working around any of them.

Stack & hard constraints (non-negotiable)


Electron + strict TypeScript. Renderer configured with contextIsolation: true, sandbox: true, nodeIntegration: false. All privileged work happens in the main process; the renderer talks to it only through a narrow contextBridge API defined in the preload script.
Agent loop: implement it yourself with @anthropic-ai/sdk (the plain Messages API client). Do NOT use @anthropic-ai/claude-agent-sdk or any agent framework — the loop is ~150 lines and we want full control of it (details below).
Model: claude-sonnet-4-6 (configurable via env AGENT_MODEL). Auth via ANTHROPIC_API_KEY env var for the PoC. Isolate all client construction in one module (src/main/agent/client.ts) so Bedrock can be swapped in later by changing only that file.
No native npm modules anywhere in the dependency tree's install path. npm install must succeed on a machine with no compiler toolchain (no node-gyp, no electron-rebuild), on Windows, macOS, and Linux.
The agent has no network capability. No fetch/HTTP tool, no bash tool, no shell access of any kind. The only network traffic in the entire app is the Messages API call from the main process.
Sandboxed code execution via quickjs-emscripten (QuickJS compiled to WASM). Do not use vm, vm2, or isolated-vm.
Agent-visible file content never touches disk (see Virtual workspace). The only code path that writes workspace content to disk is the explicit user-initiated export dialog.


Architecture

Renderer (UI) ── IPC (contextBridge) ── Main process
                                          ├─ runAgent() loop (@anthropic-ai/sdk)
                                          ├─ Tool registry
                                          │    ├─ file tools ──► VirtualWorkspace
                                          │    └─ run_javascript ──► QuickJS-WASM guest
                                          └─ VirtualWorkspace (in-memory, per task)

Virtual workspace (in-memory VFS)

Privacy requirement: staged files and agent outputs must never be written to disk. A hard-killed process must leave zero readable residue. The workspace is therefore an in-memory virtual filesystem, not a directory.


VirtualWorkspace class in the main process: conceptually Map<string, Buffer> keyed by normalized, workspace-relative, POSIX-style paths (data/input.csv). Directories are implicit from key prefixes. Track per-file status: provided | created | modified.
On task start: read the user-staged files from their original locations (read-only; originals are never modified) into the VFS under their basenames (disambiguate collisions with a numeric suffix).
Size caps with clear errors: ~50MB per file, ~500MB total.
One VirtualWorkspace per task; simply dereferenced when the task is discarded. There is no cleanup code because there is nothing on disk to clean.
Export is explicit and user-initiated only: "Save file…" / "Save all…" in the results panel via dialog.showSaveDialog / showOpenDialog(directory). No other code path may write workspace content anywhere — no os.tmpdir() spills, no on-disk caching, no debug dumps of file contents.
Text-vs-binary: tools operate on UTF-8 text. If a staged file isn't valid UTF-8, read_file should say so rather than return mojibake; binary passthrough (export unchanged) is fine.


Path validator (security-critical — write carefully, test hardest)

One function used by every VFS operation and every guest-injected file function:

ts/** Returns the canonical VFS key, or throws WorkspacePathError. */
function normalizeWorkspacePath(userPath: string): string


Pure string-level normalization (there is no real filesystem to resolve against): convert \ to /, split on /, drop empty and . segments, apply .. logically, reject if anything escapes the root.
Reject: escaping paths (any leading .. after collapse), absolute paths in any form (/x, C:\x, C:/x, \\server\share, //x), null bytes, and empty results.
Even though symlinks/junctions/ADS are meaningless in a Map, still reject Windows device names (CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9; case-insensitive; with or without extension) and name:stream forms as path segments, so exported filenames can never be dangerous on Windows.
Unit tests (vitest or node:test) covering at minimum: ../a, a/../../b, a/./b, trailing and doubled slashes, backslash mixing (..\..\x), POSIX and Windows absolute forms, UNC paths, device names with and without extensions, file.txt:ads, null bytes, and round-trip stability (normalizing a normalized path is a no-op).
The export handler must additionally sanitize the suggested filename before passing it to the save dialog.


Agent loop (recursion-ready)

Implement in src/main/agent/loop.ts:

tsinterface AgentRunOptions {
  task: string;
  tools: AgentTool<any>[];
  vfs: VirtualWorkspace;
  emit: (event: AgentEvent) => void;  // streamed to renderer over IPC
  signal: AbortSignal;                // cancellation, propagates everywhere
  depth: number;                      // 0 for top-level
  budget: TokenBudget;                // shared mutable counter across the whole tree
}
async function runAgent(opts: AgentRunOptions): Promise<string>


Standard tool loop: send messages → while stop_reason === "tool_use", execute each requested tool through the registry, append tool_result blocks, continue. Return the final assistant text.
No module-level session state. Everything flows through AgentRunOptions — this is what makes subagents (below) a pure recursive call later.
Use streaming for assistant turns and emit deltas so the UI renders text as it arrives. Emit structured events: assistant_text_delta, tool_call, tool_result, turn_complete, error, done.
A tool handler throwing must never crash the loop: catch, return the error message as an is_error: true tool result so the model can react, and emit it.
Guards: max 30 loop iterations per run; budget tracks cumulative input+output tokens from API responses and aborts the run with a clear error at a configurable ceiling (default ~500k tokens). Check signal before each API call and each tool execution.
System prompt (keep it short, store in one file): explain the environment — an in-memory workspace of user files, the exact tool list, that there is no shell/network/internet, that all paths are workspace-relative, and that it should end with a concise summary of what it did and which files it created or modified.


Subagents (design for now, one small tool later)

Not required for the PoC's acceptance checks, but structure for it: a future spawn_subagent(task) tool is just runAgent({...same vfs, depth: depth+1, budget /* shared */, ...}) whose return string becomes the tool result. Enforce depth <= 2 in that handler when added. Nothing else in the codebase should assume a single agent instance.

Tool registry

tsinterface ToolContext {
  vfs: VirtualWorkspace;
  normalizePath(p: string): string;      // the validator, injected
  emit(event: AgentEvent): void;
  signal: AbortSignal;
}

interface AgentTool<In> {
  name: string;
  description: string;                    // prompt engineering — be precise and complete
  inputSchema: JSONSchema;                // hand-written JSON Schema is fine for the PoC
  handler(input: In, ctx: ToolContext): Promise<string>;
}

Tools cannot reach the OS except through ctx — keep it that way. Implement exactly these six (all paths workspace-relative, all through ctx.normalizePath):


read_file(path) → contents; cap ~256KB per read and tell the model when truncated ([truncated: showing first N of M bytes]).
write_file(path, content) → create or overwrite; parent "directories" are implicit.
edit_file(path, old_string, new_string) → exact-string replace; if old_string is missing or matches more than once, fail with a message that tells the model how to fix its call.
list_files(path?) → recursive listing with byte sizes and status markers.
search_files(pattern, path?, is_regex?) → line-oriented search over VFS text files, implemented in TypeScript (no external binaries); return path:line: text matches, capped at 200 with a truncation note.
run_javascript(code) → QuickJS execution (below).


Tool descriptions are how the model learns this environment; write them as carefully as the code. run_javascript's description must enumerate the exact globals available and state explicitly that require, import, fetch, process, timers, and the network do not exist.

run_javascript (QuickJS-WASM)


Fresh QuickJS runtime + context per call; dispose all handles rigorously (use the library's Scope/using patterns — leaks here are the classic bug with this library).
Limits: setMemoryLimit(256MB), interrupt handler enforcing a 30s wall-clock deadline, and honor ctx.signal.
Inject synchronous host functions, each routed through the validator and VFS: readFile(path), writeFile(path, content), listFiles(path?), and log(msg) (appends to a transcript). Marshal only strings and JSON-serializable values across the membrane — never host objects, handles, or functions-returning-handles.
Return to the model, clearly labeled: the completion value (String()-ified), the log() transcript, and any thrown error's message. Cap combined output returned to the model at ~64KB with a truncation note.
On guest OOM/interrupt, return a clean error string; the app must remain responsive.


UI (minimal but real)

Single window; plain TypeScript + HTML/CSS or React, whichever you'll build fastest:


Staging area: "Add files" (dialog.showOpenDialog, multi-select) with a list of staged files (name, size) and remove buttons.
Task input: textarea + Run button (disabled while running).
Live transcript: streamed assistant text; tool calls rendered as collapsed rows (tool name + one-line input summary) expandable to full input/result; errors visible.
Results panel: workspace file list with provided/created/modified badges; click to view contents (fetched from the VFS over IPC); per-file "Save file…" and a "Save all…" button — the only export paths.
Cancel button wired to the AbortSignal; a cancelled run must settle cleanly (no dangling API calls or stuck UI state).
Show cumulative token usage for the run somewhere unobtrusive.


IPC surface (preload): stageFiles, removeStagedFile, startTask(task), cancelTask, onAgentEvent(cb), getWorkspaceFile(path), exportFile(path), exportAll(). Nothing else. Validate all IPC inputs in the main process.

Project conventions


Scaffold with electron-vite (or electron-forge + vite). Strict TS everywhere, no any in the security-relevant modules.
Layout: src/main/ (agent/, tools/, workspace/, ipc.ts), src/preload/, src/renderer/, tests/.
Scripts: dev, build, test, typecheck.
Dependencies: electron, @anthropic-ai/sdk, quickjs-emscripten, vite tooling, one test runner, optionally React. Ask me before adding anything else.
README containing: setup and env vars; how to run; the architecture sketch; and a "Security & privacy model" section stating the guarantees (agent-visible files exist only in memory — nothing to wipe even on hard kill; agent has zero network and zero shell; guest code runs in a capability-based WASM sandbox with only the injected functions) and the honest limits (prompt injection via staged file contents can still mangle workspace contents, so users should review before export; workspace is RAM-bounded; file contents are sent to the LLM API as context, so "local-only" means local residue, not end-to-end secrecy).


Acceptance checks (verify each one yourself before declaring done)


npm install completes with no compiler toolchain present; npm run typecheck and npm test pass.
Path validator tests pass, including every case listed in its section.
End-to-end happy path: stage a CSV, task "Summarize this CSV and write your findings to summary.md" → agent reads, optionally computes via run_javascript, writes summary.md; UI shows it as created; export produces a correct file.
Adversarial paths: task "Write to ../../escape.txt, then read C:\Windows\win.ini and ~/.ssh/id_rsa" → every attempt returns a validation error to the model; the VFS contains no escaped keys; no file outside user-chosen export locations is created.
No-residue check: instrument or review to confirm the only fs write call sites in the app are the export handlers; run a full task and diff userData, os.tmpdir(), and the CWD before/after to confirm nothing was written.
run_javascript with while(true){} → cleanly interrupted at the deadline; a second task afterwards works normally.
Guest capability check: evaluate [typeof fetch, typeof require, typeof process, typeof setTimeout].join() in the guest → all "undefined".
Staging a >50MB file is rejected with a clear message, not truncated or crashed.
Cancel mid-run: transcript stops, UI returns to idle, a new task can start.


Build order

Work incrementally with a commit per step: scaffold → validator + tests → VirtualWorkspace + tests → tool registry + file tools → QuickJS tool → agent loop → IPC + UI → acceptance checks. If any constraint in this document blocks you, stop and ask me instead of relaxing it.