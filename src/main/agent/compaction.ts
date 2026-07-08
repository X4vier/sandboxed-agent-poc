/**
 * Context compaction for long sessions, shaped after Pi's compaction module
 * (packages/coding-agent/src/core/compaction): a settings object, a pure
 * {@link shouldCompact} predicate, and a {@link compact} function that produces
 * the replacement history. The summarization call goes through the injected
 * {@link CompletionEngine}, so this module is itself extractable.
 *
 * Our strategy is summarize-and-replace: the whole transcript collapses into a
 * single fresh user turn holding the original task plus a summary. (Pi keeps the
 * most recent turns verbatim and only summarizes older ones — see the note in
 * the brief; that cut-point selection is intentionally not ported, because
 * replace-all leaves no tool_use/tool_result pair to split.)
 */

import type { MessageParam, Tool, Usage } from '@anthropic-ai/sdk/resources/messages';
import type { CompletionEngine } from './engine';
import { asBlocks, cachedMessages, cachedSystem, cachedTools, extractText, streamTurn } from './messages';

export interface CompactionSettings {
  /** Fraction of the context window at which compaction triggers (0 < x < 1). */
  thresholdFraction: number;
  /** Output-token ceiling for the summary the engine writes. */
  summaryMaxTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  thresholdFraction: 0.8,
  summaryMaxTokens: 4000,
};

export const COMPACTION_INSTRUCTION =
  'You are about to run out of context window. Write a thorough summary of this ' +
  'working session so a fresh instance of you can continue seamlessly with only ' +
  'this summary. Capture: the original task and its current status; every file you ' +
  'have created, modified, or read and what each contains; concrete findings, ' +
  'data, and decisions so far; and the exact next steps that remain. Be specific — ' +
  'name files, values, and paths. Do NOT call any tool; reply with the summary text only.';

/**
 * True when the most recent turn's context occupancy has crossed the configured
 * fraction of the window. Pure — no I/O.
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  return contextTokens > contextWindow * settings.thresholdFraction;
}

export interface CompactionInput {
  /** System prompt for the summarization request. */
  system: string;
  /** Tools, still passed so historical tool_use blocks validate. */
  tools: Tool[];
  /** The transcript so far; its last message is the user turn with tool results. */
  messages: MessageParam[];
  /** The original task, preserved verbatim atop the replacement message. */
  task: string;
}

export interface CompactionResult {
  /** The replacement transcript: a single summarized user turn. */
  messages: MessageParam[];
  /** Token usage of the summarization call, for the caller to bill. */
  usage: Usage;
}

/**
 * Summarize the conversation into one fresh user turn so the agent can keep
 * working within the window. The summary request reuses the real history (with
 * an instruction appended to the trailing user turn) and forbids tool calls so
 * the model replies with prose. The caller swaps its transcript for the result
 * and bills `usage`.
 */
export async function compact(
  engine: CompletionEngine,
  input: CompactionInput,
  settings: CompactionSettings,
  signal: AbortSignal,
): Promise<CompactionResult> {
  const { system, tools, messages, task } = input;
  const last = messages[messages.length - 1];
  // Compaction only runs at a turn boundary, where the last message is the user
  // turn carrying the previous tool results — safe to extend with a text block.
  const requestMessages: MessageParam[] = [
    ...messages.slice(0, -1),
    { role: last.role, content: [...asBlocks(last.content), { type: 'text', text: COMPACTION_INSTRUCTION }] },
  ];

  const final = await streamTurn(engine, {
    system: cachedSystem(system),
    messages: cachedMessages(requestMessages),
    tools: cachedTools(tools),
    maxTokens: settings.summaryMaxTokens,
    signal,
    toolChoice: 'none',
  });
  const summary = extractText(final.content).trim();

  return {
    usage: final.usage,
    messages: [
      {
        role: 'user',
        content:
          `${task}\n\n[Your earlier context was automatically compacted to stay within the ` +
          `window. This is a summary of everything done so far — treat it as your memory of ` +
          `the session:]\n\n${summary}\n\n[Resume the task from here. Re-read any file whose ` +
          `current contents you need; they are unchanged in the workspace.]`,
      },
    ],
  };
}
