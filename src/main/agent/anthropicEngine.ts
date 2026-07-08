/**
 * The default {@link CompletionEngine}: a thin adapter over the Anthropic SDK.
 *
 * This is the ONLY file under `src/main/agent/` allowed to touch `client.ts`
 * (the SDK client + model/effort/context-window config). The loop and the Agent
 * consume the {@link CompletionEngine} interface, so swapping providers — or
 * embedding the core elsewhere — means replacing only this adapter.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, Usage } from '@anthropic-ai/sdk/resources/messages';
import { AGENT_MODEL, getClient, getContextWindow, getEffort } from './client';
import type { CompletionEngine, EngineEvent, EngineRequest } from './engine';

/** Zero usage reported for a failed or aborted turn. */
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as Usage;

export function createAnthropicEngine(): CompletionEngine {
  const effort = getEffort();
  return {
    contextWindow: getContextWindow(),
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      const client: Anthropic = getClient();
      let final;
      try {
        const stream = client.messages.stream(
          {
            model: AGENT_MODEL,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: req.messages,
            tools: req.tools,
            ...(req.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}),
            output_config: { effort },
          },
          { signal: req.signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text };
          } else if (
            event.type === 'content_block_start' &&
            event.content_block.type === 'tool_use'
          ) {
            // Surface each tool_use the instant its block opens, so the UI can
            // render a pending row before the (possibly large) input streams in.
            yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name };
          }
        }
        final = await stream.finalMessage();
      } catch (e) {
        // Per the CompletionEngine contract, failures are reported as a final
        // message event, not thrown. Abort is distinguished so the loop cancels
        // rather than surfacing an error.
        if (req.signal.aborted) {
          yield { type: 'message', message: { content: [], stopReason: 'aborted', usage: ZERO_USAGE } };
          return;
        }
        yield {
          type: 'message',
          message: {
            content: [],
            stopReason: 'error',
            usage: ZERO_USAGE,
            errorMessage: (e as Error).message ?? String(e),
          },
        };
        return;
      }
      yield {
        type: 'message',
        message: {
          content: final.content as ContentBlockParam[],
          stopReason: final.stop_reason,
          usage: final.usage,
        },
      };
    },
  };
}
