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
import {
  AGENT_MODEL,
  getClient,
  getCompactionThreshold,
  getContextWindow,
  getEffort,
} from './client';
import { buildSystemPrompt } from './systemPrompt';

const MAX_ITERATIONS = 30;
// Streaming, so HTTP timeouts aren't a concern; leave headroom for adaptive
// thinking (on by default on Sonnet 5) plus the response.
const MAX_TOKENS_PER_TURN = 16000;
// Room for the summary a compaction pass writes before it replaces history.
const COMPACTION_MAX_TOKENS = 4000;

const COMPACTION_INSTRUCTION =
  'You are about to run out of context window. Write a thorough summary of this ' +
  'working session so a fresh instance of you can continue seamlessly with only ' +
  'this summary. Capture: the original task and its current status; every file you ' +
  'have created, modified, or read and what each contains; concrete findings, ' +
  'data, and decisions so far; and the exact next steps that remain. Be specific — ' +
  'name files, values, and paths. Do NOT call any tool; reply with the summary text only.';

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

function asBlocks(content: MessageParam['content']): ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/**
 * Summarize the conversation so far into a single fresh user turn, so the agent
 * can keep working with a small context instead of overflowing the window. The
 * summary request reuses the real history (with an instruction appended to the
 * trailing user turn) and the instruction tells the model to answer with prose,
 * not a tool call. The original task is preserved verbatim at the top of the
 * replacement message. Tools are still passed so the historical tool_use blocks
 * validate.
 */
async function compactHistory(
  client: Anthropic,
  system: string,
  tools: Tool[],
  messages: MessageParam[],
  task: string,
  effort: ReturnType<typeof getEffort>,
  budget: TokenBudget,
  signal: AbortSignal,
): Promise<MessageParam[]> {
  const last = messages[messages.length - 1];
  // Compaction only runs at a turn boundary, where the last message is the user
  // turn carrying the previous tool results — safe to extend with a text block.
  const requestMessages: MessageParam[] = [
    ...messages.slice(0, -1),
    { role: last.role, content: [...asBlocks(last.content), { type: 'text', text: COMPACTION_INSTRUCTION }] },
  ];

  const stream = client.messages.stream(
    {
      model: AGENT_MODEL,
      max_tokens: COMPACTION_MAX_TOKENS,
      system,
      messages: requestMessages,
      tools,
      tool_choice: { type: 'none' },
      output_config: { effort },
    },
    { signal },
  );
  const final = await stream.finalMessage();
  budget.add(final.usage.input_tokens ?? 0, final.usage.output_tokens);
  const summary = extractText(final.content as ContentBlockParam[]).trim();

  return [
    {
      role: 'user',
      content:
        `${task}\n\n[Your earlier context was automatically compacted to stay within the ` +
        `window. This is a summary of everything done so far — treat it as your memory of ` +
        `the session:]\n\n${summary}\n\n[Resume the task from here. Re-read any file whose ` +
        `current contents you need; they are unchanged in the workspace.]`,
    },
  ];
}

export async function runAgent(opts: AgentRunOptions): Promise<string> {
  const { task, tools, vfs, emit, signal, depth, budget } = opts;
  const isRoot = depth === 0;
  const registry = new ToolRegistry(tools);
  const apiTools = registry.toApiTools() as unknown as Tool[];
  const system = buildSystemPrompt(tools, depth);
  const effort = getEffort();
  const client: Anthropic = getClient();
  const compactAt = getContextWindow() * getCompactionThreshold();

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
    // context window at the next depth and compacts it independently. The shared
    // budget just accumulates the whole tree's usage for reporting.
    runSubagent: (subtask) =>
      runAgent({ task: subtask, tools, vfs, emit, signal, depth: depth + 1, budget }),
  };
  let messages: MessageParam[] = [{ role: 'user', content: task }];
  // Tokens the model read on the most recent turn ≈ how full this agent's
  // context window currently is. Watched for compaction; 0 before the first turn.
  let contextTokens = 0;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal.aborted) throw new CancelledError();

      // Approaching the window: summarize history and continue rather than
      // letting the next request overflow. Never aborts the run.
      if (contextTokens > compactAt) {
        emit({ type: 'compaction', depth, contextTokens });
        messages = await compactHistory(client, system, apiTools, messages, task, effort, budget, signal);
        contextTokens = 0;
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
      contextTokens = final.usage.input_tokens ?? 0;
      budget.add(contextTokens, final.usage.output_tokens);
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
