import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';
import type { AgentEvent } from './events';
import { normalizeWorkspacePath } from '../workspace/normalizePath';
import type { VirtualWorkspace } from '../workspace/VirtualWorkspace';
import { ToolRegistry } from '../tools/registry';
import type { AgentTool, ToolContext, TokenBudget } from './types';
import type { CompletionEngine, EngineEvent, EngineMessage, EngineRequest } from './engine';
import { buildSystemPrompt } from './systemPrompt';

const MAX_ITERATIONS = 100;
// Streaming, so HTTP timeouts aren't a concern; leave headroom for adaptive
// thinking (on by default on Sonnet 5) plus the response.
const MAX_TOKENS_PER_TURN = 16000;
// Room for the summary a compaction pass writes before it replaces history.
const COMPACTION_MAX_TOKENS = 4000;
// Fraction of the engine's context window at which an agent compacts its
// history. Task 3 moves this (and the AGENT_COMPACT_THRESHOLD env override) into
// a CompactionSettings object; kept as a constant here for the engine-injection
// step so loop.ts no longer imports client.ts.
const COMPACTION_THRESHOLD = 0.8;

const COMPACTION_INSTRUCTION =
  'You are about to run out of context window. Write a thorough summary of this ' +
  'working session so a fresh instance of you can continue seamlessly with only ' +
  'this summary. Capture: the original task and its current status; every file you ' +
  'have created, modified, or read and what each contains; concrete findings, ' +
  'data, and decisions so far; and the exact next steps that remain. Be specific — ' +
  'name files, values, and paths. Do NOT call any tool; reply with the summary text only.';

const CACHE_CONTROL: CacheControlEphemeral = { type: 'ephemeral' };

export interface AgentRunOptions {
  task: string;
  tools: AgentTool[];
  vfs: VirtualWorkspace;
  /** The text-completion engine the loop streams each turn through. */
  engine: CompletionEngine;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  depth: number;
  agentId: string;
  parentAgentId: string | null;
  budget: TokenBudget;
  /**
   * Prior conversation turns to resume from (root follow-ups). When non-empty,
   * `task` is appended as a new user turn after this history instead of starting
   * a fresh conversation. Subagents never pass this.
   */
  priorMessages?: MessageParam[];
  /** Context-window fill carried from the prior turn, seeding the compaction check. */
  priorContextTokens?: number;
  /**
   * Root only: invoked on clean completion with the full message history and the
   * current context-window fill, so the caller can persist them and continue the
   * conversation with a follow-up message.
   */
  onConversationState?: (messages: MessageParam[], contextTokens: number) => void;
  /**
   * Root only: polled at each turn boundary (after tool results are appended, and
   * at the point where the loop would otherwise stop) for user messages to inject
   * mid-run. Returning a non-empty array appends those turns and keeps the loop
   * going instead of stopping. Subagents never pass this.
   */
  drainSteering?: () => MessageParam[];
}

class CancelledError extends Error {
  constructor() {
    super('Run cancelled.');
    this.name = 'CancelledError';
  }
}

interface ExecutedToolUse {
  use: ToolUseBlock;
  result: string;
  isError: boolean;
}

type TaskOutcome =
  | { status: 'fulfilled'; index: number; execution: ExecutedToolUse }
  | { status: 'rejected'; index: number; error: unknown };

function extractText(content: ContentBlockParam[]): string {
  return content
    .filter((b): b is Extract<ContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function asBlocks(content: MessageParam['content']): ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function cachedSystem(system: string): TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: CACHE_CONTROL }];
}

function cachedTools(tools: Tool[]): Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [...tools.slice(0, -1), { ...last, cache_control: CACHE_CONTROL }];
}

function cachedMessages(messages: MessageParam[]): MessageParam[] {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A snapshot of everything staged in the workspace, prepended to the root
 * agent's opening turn so it always starts knowing what's available (and how
 * many files there are) without having to call list_files first. Returns null
 * when the workspace is empty — there's no list to lead with.
 */
function buildFileManifest(vfs: VirtualWorkspace): string | null {
  const files = vfs.list();
  if (files.length === 0) return null;
  const lines = files.map((f) => `  - ${f.path} (${f.status}, ${formatBytes(f.size)})`);
  return [
    `Your workspace has ${files.length} file${files.length === 1 ? '' : 's'} already staged and ready. ` +
      'All paths are workspace-relative; open any of them with Read, read_document, or Grep, ' +
      'and refresh this list anytime with list_files.',
    '',
    ...lines,
  ].join('\n');
}

function inputUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function addUsage(budget: TokenBudget, usage: Usage): void {
  budget.add(
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
  );
}

/**
 * Consume one engine turn to completion, forwarding streamed text / tool-use
 * events to `onEvent`, and return the final message. Centralizes the stop/cancel
 * handling: an aborted turn becomes a CancelledError, a failed turn rethrows its
 * error message (both land in the loop's outer catch).
 */
async function streamTurn(
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
  engine: CompletionEngine,
  system: string,
  tools: Tool[],
  messages: MessageParam[],
  task: string,
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

  const final = await streamTurn(engine, {
    system: cachedSystem(system),
    messages: cachedMessages(requestMessages),
    tools: cachedTools(tools),
    maxTokens: COMPACTION_MAX_TOKENS,
    signal,
    toolChoice: 'none',
  });
  addUsage(budget, final.usage);
  const summary = extractText(final.content).trim();

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
  const {
    task,
    tools,
    vfs,
    engine,
    emit,
    signal,
    depth,
    agentId,
    parentAgentId,
    budget,
    priorMessages,
    priorContextTokens,
    onConversationState,
    drainSteering,
  } = opts;
  const isRoot = depth === 0;
  const eventBase = { agentId, parentAgentId, depth };
  const registry = new ToolRegistry(tools);
  const apiTools = registry.toApiTools() as unknown as Tool[];
  const system = buildSystemPrompt(tools, depth);
  const compactAt = engine.contextWindow * COMPACTION_THRESHOLD;

  // Media queued by tools during a turn; appended to that turn's user message
  // (after the tool_result blocks) and cleared each iteration.
  const pendingMedia: ContentBlockParam[] = [];
  const baseCtx: Omit<ToolContext, 'runSubagent'> = {
    vfs,
    normalizePath: normalizeWorkspacePath,
    emit,
    signal,
    attachBlocks: (blocks) => pendingMedia.push(...blocks),
    depth,
    agentId,
    parentAgentId,
  };

  const executeToolUse = async (use: ToolUseBlock): Promise<ExecutedToolUse> => {
    if (signal.aborted) throw new CancelledError();
    emit({ type: 'tool_call', id: use.id, name: use.name, input: use.input, ...eventBase });
    let result: string;
    let isError = false;
    const ctx: ToolContext = {
      ...baseCtx,
      // Reuse this run's shared vfs/emit/signal/budget; the child gets its own
      // context window at the next depth and compacts it independently. The shared
      // budget just accumulates the whole tree's usage for reporting.
      runSubagent: (subtask) =>
        runAgent({
          task: subtask,
          tools,
          vfs,
          engine,
          emit,
          signal,
          depth: depth + 1,
          agentId: use.id,
          parentAgentId: agentId,
          budget,
        }),
    };
    try {
      result = await registry.execute(use.name, use.input, ctx);
      if (signal.aborted) throw new CancelledError();
    } catch (e) {
      if (signal.aborted || e instanceof CancelledError) throw new CancelledError();
      result = `Error: ${(e as Error).message}`;
      isError = true;
    }
    emit({ type: 'tool_result', id: use.id, name: use.name, result, isError, ...eventBase });
    return { use, result, isError };
  };

  const toToolResultBlock = (execution: ExecutedToolUse): ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: execution.use.id,
    content: execution.result,
    ...(execution.isError ? { is_error: true } : {}),
  });

  // Resume from a prior conversation (root follow-up) by appending the new task
  // as a fresh user turn; otherwise start clean. Prior history already ends with
  // an assistant turn, so this keeps the user/assistant alternation valid.
  //
  // On a fresh root conversation, lead with a manifest of the staged workspace
  // so the agent always begins knowing what files exist. Follow-ups already have
  // it earlier in history; subagents get scoped tasks instead of the full list.
  const isFreshRoot = isRoot && !(priorMessages && priorMessages.length > 0);
  const manifest = isFreshRoot ? buildFileManifest(vfs) : null;
  const openingTurn: MessageParam = manifest
    ? {
        role: 'user',
        content: [
          { type: 'text', text: manifest },
          { type: 'text', text: task },
        ],
      }
    : { role: 'user', content: task };
  let messages: MessageParam[] =
    priorMessages && priorMessages.length > 0
      ? [...priorMessages, openingTurn]
      : [openingTurn];
  // Tokens the model read on the most recent turn ≈ how full this agent's
  // context window currently is. Watched for compaction; carried across
  // follow-ups, else 0 before the first turn.
  let contextTokens = priorContextTokens ?? 0;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal.aborted) throw new CancelledError();

      // Approaching the window: summarize history and continue rather than
      // letting the next request overflow. Never aborts the run.
      if (contextTokens > compactAt) {
        emit({ type: 'compaction', contextTokens, ...eventBase });
        messages = await compactHistory(engine, system, apiTools, messages, task, budget, signal);
        contextTokens = 0;
      }

      const final = await streamTurn(
        engine,
        {
          system: cachedSystem(system),
          messages: cachedMessages(messages),
          tools: cachedTools(apiTools),
          maxTokens: MAX_TOKENS_PER_TURN,
          signal,
        },
        (ev) => {
          if (ev.type === 'text') {
            emit({ type: 'assistant_text_delta', text: ev.text, ...eventBase });
          } else {
            emit({ type: 'tool_call_start', id: ev.id, name: ev.name, ...eventBase });
          }
        },
      );
      contextTokens = inputUsage(final.usage);
      addUsage(budget, final.usage);
      emit({ type: 'turn_complete', usage: budget.snapshot(), ...eventBase });

      const assistantContent = final.content;
      messages.push({ role: 'assistant', content: assistantContent });

      if (final.stopReason !== 'tool_use') {
        // The model is ready to stop. Before doing so, pull any user messages the
        // caller has queued (steering): if there are any, append them as a fresh
        // user turn and keep going rather than ending the run. The last message
        // is the assistant turn just pushed, so this preserves alternation.
        const steered = drainSteering?.() ?? [];
        if (steered.length > 0) {
          messages.push(...steered);
          continue;
        }
        const text = extractText(assistantContent);
        if (isRoot) {
          // Hand the completed history back so the caller can persist it and let
          // the user continue this conversation with a follow-up message.
          onConversationState?.(messages, contextTokens);
          emit({ type: 'done', summary: text, usage: budget.snapshot(), ...eventBase });
        }
        return text;
      }

      const toolUses = final.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );
      const resultsByIndex: Array<ExecutedToolUse | undefined> = new Array(toolUses.length);
      const indexedToolUses = toolUses.map((use, index) => ({ use, index }));
      const taskPromises = indexedToolUses
        .filter(({ use }) => use.name === 'Task')
        .map(({ use, index }): Promise<TaskOutcome> =>
          executeToolUse(use).then(
            (execution) => ({ status: 'fulfilled', index, execution }),
            (error) => ({ status: 'rejected', index, error }),
          ),
        );

      let pendingError: unknown;
      for (const { use, index } of indexedToolUses) {
        if (use.name === 'Task') continue;
        try {
          resultsByIndex[index] = await executeToolUse(use);
        } catch (e) {
          pendingError = e;
          break;
        }
      }

      const taskOutcomes = await Promise.all(taskPromises);
      for (const outcome of taskOutcomes) {
        if (outcome.status === 'fulfilled') {
          resultsByIndex[outcome.index] = outcome.execution;
        } else if (pendingError === undefined) {
          pendingError = outcome.error;
        }
      }
      if (pendingError !== undefined) throw pendingError;

      const results = resultsByIndex.map((execution, index) => {
        if (!execution) {
          throw new Error(`Missing tool result for tool_use ${toolUses[index]?.id ?? index}.`);
        }
        return toToolResultBlock(execution);
      });
      // Fold any queued steering messages into this same user turn, after the
      // tool results and media. Keeping them in one turn avoids two consecutive
      // user messages and lets the compaction accounting (driven by the next
      // turn's input_tokens) and the handed-back history see them for free.
      const steeredBlocks = (drainSteering?.() ?? []).flatMap((m) => asBlocks(m.content));
      messages.push({ role: 'user', content: [...results, ...pendingMedia, ...steeredBlocks] });
      pendingMedia.length = 0;
    }

    throw new Error(`Task was cut off at the ${MAX_ITERATIONS}-iteration limit before it finished.`);
  } catch (e) {
    if (e instanceof CancelledError) {
      if (isRoot) emit({ type: 'error', message: 'Run cancelled.', ...eventBase });
      throw e;
    }
    const message = (e as Error).message ?? String(e);
    if (isRoot) emit({ type: 'error', message, ...eventBase });
    throw e;
  }
}
