import type {
  ContentBlockParam,
  MessageParam,
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
import type { CompletionEngine } from './engine';
import {
  asBlocks,
  cachedMessages,
  cachedSystem,
  cachedTools,
  CancelledError,
  extractText,
  streamTurn,
} from './messages';
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  shouldCompact,
  type CompactionSettings,
} from './compaction';
import { buildSystemPrompt } from './systemPrompt';

const MAX_ITERATIONS = 100;
// Streaming, so HTTP timeouts aren't a concern; leave headroom for adaptive
// thinking (on by default on Sonnet 5) plus the response.
const MAX_TOKENS_PER_TURN = 16000;

/** Context passed to {@link AgentRunOptions.beforeToolCall} / afterToolCall. */
export interface ToolCallContext {
  /** The tool_use block the model emitted (id, name, input). */
  toolUse: ToolUseBlock;
  /** Nesting depth of the agent making the call (0 = root). */
  depth: number;
  /** Identity of the agent making the call. */
  agentId: string;
}

/**
 * Returned from {@link AgentRunOptions.beforeToolCall}. `{ block: true }`
 * prevents execution; `reason` becomes the (error) tool result shown to the
 * model. For an external consumer, this hook is the permission system.
 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/** Returned from {@link AgentRunOptions.afterToolCall} to rewrite a result. */
export interface AfterToolCallResult {
  result?: string;
  isError?: boolean;
}

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
  /** Compaction policy; defaults to {@link DEFAULT_COMPACTION_SETTINGS}. */
  compaction?: CompactionSettings;
  /**
   * Called after a tool_use is surfaced but before it executes. Return
   * `{ block: true, reason }` to prevent execution — the loop feeds `reason`
   * back as an error tool result instead of running the tool. Inherited by
   * subagents.
   */
  beforeToolCall?: (ctx: ToolCallContext) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
  /**
   * Called after a tool executes, before its result is emitted. Return
   * `{ result?, isError? }` to rewrite the outcome. Inherited by subagents.
   */
  afterToolCall?: (ctx: ToolCallContext & { result: string; isError: boolean }) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
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

interface ExecutedToolUse {
  use: ToolUseBlock;
  result: string;
  isError: boolean;
}

type TaskOutcome =
  | { status: 'fulfilled'; index: number; execution: ExecutedToolUse }
  | { status: 'rejected'; index: number; error: unknown };

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
    beforeToolCall,
    afterToolCall,
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
  const compactionSettings = opts.compaction ?? DEFAULT_COMPACTION_SETTINGS;

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

    // Permission hook: a blocked call never executes; its reason is returned to
    // the model as an error tool result rather than crashing the run.
    const decision = await beforeToolCall?.({ toolUse: use, depth, agentId });
    if (decision?.block) {
      result = decision.reason ?? `Tool "${use.name}" was blocked before it ran.`;
      isError = true;
    } else {
      const ctx: ToolContext = {
        ...baseCtx,
        // Reuse this run's shared vfs/engine/emit/signal/budget; the child gets
        // its own context window at the next depth and compacts it independently.
        // The shared budget just accumulates the whole tree's usage for reporting.
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
            compaction: compactionSettings,
            // Subagents inherit the parent's permission/rewrite hooks.
            ...(beforeToolCall ? { beforeToolCall } : {}),
            ...(afterToolCall ? { afterToolCall } : {}),
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
      // Rewrite hook: may replace the result text and/or error flag.
      const override = await afterToolCall?.({ toolUse: use, depth, agentId, result, isError });
      if (override) {
        if (override.result !== undefined) result = override.result;
        if (override.isError !== undefined) isError = override.isError;
      }
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
      if (shouldCompact(contextTokens, engine.contextWindow, compactionSettings)) {
        emit({ type: 'compaction', contextTokens, ...eventBase });
        const compacted = await compact(
          engine,
          { system, tools: apiTools, messages, task },
          compactionSettings,
          signal,
        );
        addUsage(budget, compacted.usage);
        messages = compacted.messages;
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
