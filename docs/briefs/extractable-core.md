# Brief: Make the agent core extractable, then clean up along Pi's structure

## Context

Repo: `~/agent-spike` — Electron PoC of a Claude agent over an in-memory VFS. **Read `CLAUDE.md` first**; its invariants are non-negotiable: agent-visible file content never touches disk, no shell/network tools, API key lives only in main-process memory, no new dependencies, no new network egress.

**Primary goal (new):** the project should decompose into pieces that can be lifted into another project without bringing the Electron app along. Concretely, a consumer should be able to take `src/main/agent` + `src/main/tools` + `src/main/workspace` (+ `documents`) as an embeddable core, **supply their own text-completion engine**, and their own event sink/UI. The Electron app (ipc, preload, renderer, client.ts wiring) becomes just one consumer of that core.

Reference codebase: `~/pi` (the Pi agent harness, MIT). We are NOT forking it — we borrow structure. Study before starting:

- `~/pi/packages/agent/src/types.ts` — the `StreamFn` injection seam (lines ~17–31) and `beforeToolCall`/`afterToolCall` hook types (lines ~60–114). This layering (agent-core knows no provider) is the model for task 1.
- `~/pi/packages/coding-agent/src/core/compaction/compaction.ts` — self-contained compaction module: settings object, `shouldCompact`, cut-point selection, summarization prompt in one place.
- `~/pi/packages/coding-agent/src/core/tools/` — one file per tool, shared `truncate.ts`, per-tool `*Operations` seams.

⚠️ Run `git status` first; build on the committed `AgentSession.ts` steering work (commit `128a613`), don't revert it. Commit in small, reviewable units — roughly one commit per numbered task. `npm run typecheck` and `npm test` green after every commit.

## Current couplings to break (verify against the tree)

- `src/main/agent/loop.ts` imports `getClient`, `AGENT_MODEL`, `getContextWindow`, `getCompactionThreshold`, `getEffort` directly from `client.ts` → the loop cannot run without our Anthropic setup.
- Agent code imports `AgentEvent` from `src/shared/ipc.ts` → the core depends on the app's IPC contract.
- Compaction logic (threshold constants, `COMPACTION_INSTRUCTION`, summarize-and-replace) is inlined in `loop.ts`.
- `src/main/tools/fileTools.ts` (~390 lines) holds Read/Write/Edit/list_files/Glob/Grep in one file.

## Tasks, in priority order

### 1. Inject the completion engine into the loop

Define in `src/main/agent/types.ts` (or a new `engine.ts`) an engine interface the loop consumes instead of importing `client.ts`. Shape it on what the loop actually uses today — do not over-generalize. Something like:

```ts
export interface CompletionEngine {
  /** Stream one assistant turn. Must honour the abort signal. */
  stream(req: {
    system: TextBlockParam[];
    messages: MessageParam[];
    tools: Tool[];
    maxTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<EngineEvent>; // text deltas, tool_use blocks, final message + usage
  contextWindow: number;
}
```

(Design the exact `EngineEvent` shape from what `loop.ts` consumes from the SDK stream today — keep it minimal; it is fine for the types to lean on `@anthropic-ai/sdk` message *types*, which are just type imports, but the core must not construct a client.)

- `runAgent` and `AgentSession` take an `engine` in their options. No imports from `client.ts` remain anywhere under `src/main/agent/` except a new thin adapter.
- Add `src/main/agent/anthropicEngine.ts` (or keep it in `client.ts`): the default implementation wrapping today's `getClient()` + model/effort config. `ipc.ts` constructs it and passes it in.
- `tests/loop.test.ts` currently mocks the SDK client; convert the mock into a `CompletionEngine` fake — the test file should get simpler, and it doubles as the reference implementation for consumers.
- Pi's `StreamFn` contract is worth copying: engine failures are returned as a final error-stop event on the stream, not thrown, so the loop's retry/stop logic stays in one place.

### 2. Decouple events from the IPC contract

`AgentEvent` currently lives in `src/shared/ipc.ts`. Move the event type definitions into the agent layer (e.g. `src/main/agent/events.ts`) and have `src/shared/ipc.ts` re-export or map them for the bridge. Direction of dependency after this task: app → core, never core → app. Grep for any other `../../shared/` imports under `agent/`, `tools/`, `workspace/`, `documents/` and eliminate them the same way. The renderer and preload keep compiling against the shared types unchanged.

### 3. Extract compaction into `src/main/agent/compaction.ts`

Move all compaction out of `loop.ts`, shaped like Pi's module:

- `CompactionSettings` (threshold fraction, summary max tokens) replacing scattered constants; `shouldCompact(contextTokens, contextWindow, settings)` pure; `compact(engine, messages, settings, signal)` returning the replacement history. The loop just calls and swaps.
- Compaction's summarize call goes through the injected engine (task 1), so the module is itself extractable.
- Optional second commit: Pi-style cut-point selection — keep the most recent complete turns verbatim, summarize only older ones, never splitting an assistant message from its tool results. Skip if it fights the current design; note it in the final summary instead.
- New `tests/compaction.test.ts`: threshold boundaries; no orphaned tool_use/tool_result pairs after compaction.

### 4. Split `fileTools.ts` one-file-per-tool + shared `truncate.ts`

Mirror Pi's `core/tools/` layout: `read.ts`, `write.ts`, `edit.ts`, `listFiles.ts`, `grep.ts` (Glob's tool can join `glob.ts` or a `globTool.ts`); `index.ts` stays the barrel; `registry.ts` behavior unchanged. **Model-visible tool names and JSON schemas must not change in this task.** Shared input parsing stays in `inputs.ts`.

Add `src/main/tools/truncate.ts` modeled on Pi's (`~/pi/packages/coding-agent/src/core/tools/truncate.ts`): `truncateHead(text, {maxLines, maxBytes})` returning slice + structured info for a continuation notice. Then:

- **Read**: byte cap (50KB) alongside the 2000-line cap, whichever hits first; explicit notice when a single line exceeds the cap; keep offset/limit semantics.
- **Grep**: match `limit` (default 100) with a truncation notice; cap each match line (~500 chars).
- Every notice tells the model how to get the rest. New `tests/truncate.test.ts`; split `tests/fileTools.test.ts` per-tool to match.

### 5. Loop hooks: `beforeToolCall` / `afterToolCall`

Optional hooks on `AgentRunOptions`, typed like Pi's but on our Anthropic-native types:

- `beforeToolCall(ctx) => { block?: boolean; reason?: string } | undefined` — blocked call yields an error tool result, not a crash.
- `afterToolCall(ctx) => { result?: string; isError?: boolean } | undefined` — may rewrite a result.

Move any per-tool-call bookkeeping already inlined in the loop behind these hooks. Subagents (`task.ts`) inherit the parent's hooks. Extend `tests/loop.test.ts` with a block case and a rewrite case. (For an external consumer, these hooks are the permission system.)

### 6. Model-visible ergonomics (additive only)

- Grep: optional `context: N` (lines before/after) and `literal: true` (escape pattern). Defaults preserve current behavior exactly.
- Tool descriptions: state concrete limits inline, Pi style ("truncated to 2000 lines or 50KB, whichever is hit first — use offset/limit to continue").
- Edit: keep the `old_string`/`new_string`/`replace_all` shape; make failure messages instructive.

### 7. Prove extraction (definition-of-done check)

Add `tests/embedding.test.ts`: construct a `VirtualWorkspace`, the standard tool set, a fake `CompletionEngine`, and run `runAgent`/`AgentSession` end-to-end **without importing anything from `src/main/ipc.ts`, `src/main/client-adjacent wiring`, `src/shared/`, `src/preload/`, or `src/renderer/`**. If that test can't be written, the decoupling isn't done. Optionally also assert import direction mechanically (a small test that greps `src/main/{agent,tools,workspace,documents}` for forbidden import paths).

## Hard constraints

- No new dependencies. No disk writes. No changes to key handling semantics, `audit.ts` counter meanings, `egress.ts`, or `normalizePath.ts`.
- Model-visible tool schemas: additions only.
- Public IPC channel names and renderer behavior unchanged (the app must work identically; `npm run dev` is the eventual smoke test).
- Security-surface changes extend the corresponding `tests/*.test.ts` per CLAUDE.md.

## Definition of done

Full suite green; `tests/embedding.test.ts` passes and proves the core runs with a consumer-supplied engine and event sink; `loop.ts` contains no provider construction, no compaction internals, no IPC imports; `tools/` is one-file-per-tool with shared `truncate.ts`; final message lists anything deliberately skipped and why.
