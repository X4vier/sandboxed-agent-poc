import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type { AgentEvent } from '../../shared/ipc';
import { normalizeWorkspacePath } from '../workspace/normalizePath';
import type { VirtualWorkspace } from '../workspace/VirtualWorkspace';
import { ToolRegistry } from '../tools/registry';
import type { AgentTool, ToolContext, TokenBudget } from './types';
import { AGENT_MODEL, getClient, getEffort } from './client';
import { buildSystemPrompt } from './systemPrompt';

const MAX_ITERATIONS = 30;
// Streaming, so HTTP timeouts aren't a concern; leave headroom for adaptive
// thinking (on by default on Sonnet 5) plus the response.
const MAX_TOKENS_PER_TURN = 16000;

export interface AgentRunOptions {
  task: string;
  tools: AgentTool[];
  vfs: VirtualWorkspace;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  depth: number;
  budget: TokenBudget;
}

class CancelledError extends Error {
  constructor() {
    super('Run cancelled.');
    this.name = 'CancelledError';
  }
}

function extractText(content: ContentBlockParam[]): string {
  return content
    .filter((b): b is Extract<ContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export async function runAgent(opts: AgentRunOptions): Promise<string> {
  const { task, tools, vfs, emit, signal, depth, budget } = opts;
  const isRoot = depth === 0;
  const registry = new ToolRegistry(tools);
  const apiTools = registry.toApiTools() as unknown as Tool[];
  const system = buildSystemPrompt(tools, depth);
  const effort = getEffort();
  const client: Anthropic = getClient();

  // Media queued by tools during a turn; appended to that turn's user message
  // (after the tool_result blocks) and cleared each iteration.
  const pendingMedia: ContentBlockParam[] = [];
  const ctx: ToolContext = {
    vfs,
    normalizePath: normalizeWorkspacePath,
    emit,
    signal,
    attachBlocks: (blocks) => pendingMedia.push(...blocks),
    depth,
    // Reuse this run's shared vfs/emit/signal/budget; the child gets its own
    // context window at the next depth. Same budget means a subagent's spend
    // counts against the whole tree and can trip the ceiling here too.
    runSubagent: (subtask) =>
      runAgent({ task: subtask, tools, vfs, emit, signal, depth: depth + 1, budget }),
  };
  const messages: MessageParam[] = [{ role: 'user', content: task }];

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal.aborted) throw new CancelledError();
      if (budget.exceeded) {
        throw new Error(
          `Token budget of ${budget.limit} exceeded (used ${budget.used}). Stopping the run.`,
        );
      }

      const stream = client.messages.stream(
        {
          model: AGENT_MODEL,
          max_tokens: MAX_TOKENS_PER_TURN,
          system,
          messages,
          tools: apiTools,
          output_config: { effort },
        },
        { signal },
      );
      stream.on('text', (delta) => emit({ type: 'assistant_text_delta', text: delta, depth }));

      const final = await stream.finalMessage();
      budget.add(final.usage.input_tokens ?? 0, final.usage.output_tokens);
      emit({ type: 'turn_complete', usage: budget.snapshot() });

      const assistantContent = final.content as ContentBlockParam[];
      messages.push({ role: 'assistant', content: assistantContent });

      if (final.stop_reason !== 'tool_use') {
        const text = extractText(assistantContent);
        if (isRoot) emit({ type: 'done', summary: text, usage: budget.snapshot() });
        return text;
      }

      const toolUses = final.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );
      const results: ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        if (signal.aborted) throw new CancelledError();
        emit({ type: 'tool_call', id: use.id, name: use.name, input: use.input, depth });
        let result: string;
        let isError = false;
        try {
          result = await registry.execute(use.name, use.input, ctx);
        } catch (e) {
          result = `Error: ${(e as Error).message}`;
          isError = true;
        }
        emit({ type: 'tool_result', id: use.id, name: use.name, result, isError, depth });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: result,
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: [...results, ...pendingMedia] });
      pendingMedia.length = 0;
    }

    throw new Error(`Reached the ${MAX_ITERATIONS}-iteration limit without finishing.`);
  } catch (e) {
    if (e instanceof CancelledError) {
      if (isRoot) emit({ type: 'error', message: 'Run cancelled.' });
      throw e;
    }
    const message = (e as Error).message ?? String(e);
    if (isRoot) emit({ type: 'error', message });
    throw e;
  }
}
