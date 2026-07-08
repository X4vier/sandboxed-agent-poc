/**
 * The completion-engine seam. The agent loop consumes a {@link CompletionEngine}
 * rather than constructing an Anthropic client itself, so the core (loop + tools
 * + workspace) can be lifted into another project that supplies its own engine.
 *
 * The types deliberately lean on `@anthropic-ai/sdk` *message* types — those are
 * plain data shapes, erased at runtime — but nothing here constructs a client.
 * The default Anthropic implementation lives in `anthropicEngine.ts`; tests and
 * external consumers provide their own.
 *
 * Modeled on Pi's `StreamFn` contract (packages/agent/src/types.ts): a turn's
 * failure is reported as a final {@link EngineMessage} carrying `errorMessage`
 * (or `stopReason: 'aborted'`) rather than thrown, so the loop's stop/cancel
 * handling stays in one place.
 */

import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';

/** One assistant turn's request, as the loop hands it to the engine. */
export interface EngineRequest {
  /** System prompt blocks (already carrying any prompt-cache breakpoints). */
  system: TextBlockParam[];
  /** Conversation so far. */
  messages: MessageParam[];
  /** Tool definitions the model may call. */
  tools: Tool[];
  /** Output token ceiling for this turn. */
  maxTokens: number;
  /** Abort signal; the engine must stop and settle when it fires. */
  signal: AbortSignal;
  /**
   * `'none'` forbids tool calls for this turn (used by compaction, which wants
   * prose back). Defaults to `'auto'`.
   */
  toolChoice?: 'auto' | 'none';
}

/** The completed assistant turn, plus the failure channel. */
export interface EngineMessage {
  /** Assistant content blocks (text, tool_use, …). Empty on failure. */
  content: ContentBlockParam[];
  /** `'tool_use'`, `'end_turn'`, `'aborted'`, `'error'`, … or null. */
  stopReason: string | null;
  /** Token usage for the turn; zeroed on failure. */
  usage: Usage;
  /** Present when the turn failed (non-abort); the loop rethrows it. */
  errorMessage?: string;
}

/** Streamed increments of one assistant turn. */
export type EngineEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'message'; message: EngineMessage };

/**
 * Streams one assistant turn at a time. The final event of every stream must be
 * a `message` event (success or failure); text/tool_use_start events precede it.
 */
export interface CompletionEngine {
  stream(req: EngineRequest): AsyncIterable<EngineEvent>;
  /** The model's usable context window, in tokens, for the compaction check. */
  readonly contextWindow: number;
}
