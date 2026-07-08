/**
 * Message shaping and single-turn engine consumption shared by the agent loop
 * and the compaction module. Kept separate so `compaction.ts` doesn't have to
 * import `loop.ts` (which would be a cycle): both depend on these helpers.
 *
 * The prompt-cache breakpoints ride on Anthropic message types; that's the one
 * provider-specific detail the core leans on (see engine.ts).
 */

import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';
import type { CompletionEngine, EngineEvent, EngineMessage, EngineRequest } from './engine';

const CACHE_CONTROL: CacheControlEphemeral = { type: 'ephemeral' };

/** Raised when a run is cancelled; the loop maps it to a clean 'Run cancelled.'. */
export class CancelledError extends Error {
  constructor() {
    super('Run cancelled.');
    this.name = 'CancelledError';
  }
}

export function extractText(content: ContentBlockParam[]): string {
  return content
    .filter((b): b is Extract<ContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function asBlocks(content: MessageParam['content']): ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function cachedSystem(system: string): TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: CACHE_CONTROL }];
}

export function cachedTools(tools: Tool[]): Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [...tools.slice(0, -1), { ...last, cache_control: CACHE_CONTROL }];
}

export function cachedMessages(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const content = asBlocks(last.content);
  if (content.length === 0) return messages;
  const lastBlock = content[content.length - 1];
  const cachedBlock = { ...(lastBlock as object), cache_control: CACHE_CONTROL } as ContentBlockParam;
  return [
    ...messages.slice(0, -1),
    {
      role: last.role,
      content: [...content.slice(0, -1), cachedBlock],
    },
  ];
}

/**
 * Consume one engine turn to completion, forwarding streamed text / tool-use
 * events to `onEvent`, and return the final message. Centralizes the stop/cancel
 * handling: an aborted turn becomes a {@link CancelledError}, a failed turn
 * rethrows its error message (both land in the loop's outer catch).
 */
export async function streamTurn(
  engine: CompletionEngine,
  req: EngineRequest,
  onEvent?: (ev: Exclude<EngineEvent, { type: 'message' }>) => void,
): Promise<EngineMessage> {
  let final: EngineMessage | undefined;
  for await (const ev of engine.stream(req)) {
    if (ev.type === 'message') final = ev.message;
    else onEvent?.(ev);
  }
  if (!final) throw new Error('The engine did not return a final message.');
  if (final.stopReason === 'aborted' || req.signal.aborted) throw new CancelledError();
  if (final.errorMessage) throw new Error(final.errorMessage);
  return final;
}
