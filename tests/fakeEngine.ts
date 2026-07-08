import type { ContentBlockParam, Usage } from '@anthropic-ai/sdk/resources/messages';
import type { CompletionEngine, EngineEvent, EngineRequest } from '../src/main/agent/engine';

/**
 * A scripted {@link CompletionEngine} for tests. It also stands as the reference
 * implementation of the engine seam for consumers embedding the core: a turn is
 * described declaratively, and the fake maps it onto the streamed event protocol
 * (text deltas, tool_use_start, and a final message that honours the abort/error
 * contract).
 */
export interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  /** Gate the turn's final message on this promise (reject to simulate failure). */
  waitFor?: Promise<void>;
  /** Force the turn to fail; surfaced as an engine error message, not a throw. */
  rejectWith?: Error;
  /** Called once the streamed events are emitted and the turn begins finalizing. */
  onStart?: () => void;
  /** Called once the turn has produced its final message (success or failure). */
  onFinish?: () => void;
}

export interface FakeEngine extends CompletionEngine {
  /** Every request the loop has streamed through, in order. */
  readonly requests: EngineRequest[];
  /** Queue scripted turns; consumed FIFO across the whole agent tree. */
  push(...turns: ScriptedTurn[]): void;
  /** Reported context window; assign to force a compaction pass. */
  contextWindow: number;
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as Usage;

export function createFakeEngine(): FakeEngine {
  const queue: ScriptedTurn[] = [];
  const requests: EngineRequest[] = [];

  const engine: FakeEngine = {
    contextWindow: 200_000,
    requests,
    push(...turns: ScriptedTurn[]): void {
      queue.push(...turns);
    },
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      const turn = queue.shift();
      if (!turn) throw new Error('no scripted turn');
      try {
        if (turn.text) yield { type: 'text', text: turn.text };
        for (const tu of turn.toolUses ?? []) {
          yield { type: 'tool_use_start', id: tu.id, name: tu.name };
        }
        turn.onStart?.();
        await turn.waitFor;
        if (turn.rejectWith) throw turn.rejectWith;
        const content: ContentBlockParam[] = [];
        if (turn.text) content.push({ type: 'text', text: turn.text, citations: null } as ContentBlockParam);
        for (const tu of turn.toolUses ?? []) {
          content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input } as ContentBlockParam);
        }
        yield {
          type: 'message',
          message: {
            content,
            stopReason: turn.stopReason,
            usage: (turn.usage ?? { input_tokens: 10, output_tokens: 5 }) as Usage,
          },
        };
      } catch (e) {
        // Mirror the real adapter's contract: encode failures as a final message
        // event (aborted vs error), never a throw out of the stream.
        if (req.signal.aborted) {
          yield { type: 'message', message: { content: [], stopReason: 'aborted', usage: ZERO_USAGE } };
        } else {
          yield {
            type: 'message',
            message: {
              content: [],
              stopReason: 'error',
              usage: ZERO_USAGE,
              errorMessage: (e as Error).message ?? String(e),
            },
          };
        }
      } finally {
        turn.onFinish?.();
      }
    },
  };

  return engine;
}
