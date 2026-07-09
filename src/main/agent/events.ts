/**
 * Agent-layer event contract. These types belong to the extractable core: the
 * loop and tools emit them, and the app (see `src/shared/ipc.ts`, which
 * re-exports them) mirrors them to the renderer over IPC. Dependency direction
 * is app → core, so nothing here imports from the app/IPC layer.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Imperative description of the step, e.g. "Convert the CSV to JSON". */
  content: string;
  status: TodoStatus;
  /** Present-tense form shown while in progress, e.g. "Converting the CSV to JSON". */
  activeForm?: string;
}

/**
 * Identity shared by streamed events from one logical agent run. `agentId` is
 * the stable routing key (`root` for the root agent; a Task tool_use id for a
 * subagent). `depth` remains useful display metadata.
 */
export interface AgentEventIdentity {
  agentId: string;
  parentAgentId: string | null;
  depth: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

/**
 * Streamed agent events. The app mirrors these to the renderer over IPC.
 */
export type AgentEvent =
  | ({ type: 'assistant_text_delta'; text: string } & AgentEventIdentity)
  // Emitted the instant a tool_use block begins streaming, before its input has
  // finished arriving. Lets the UI show the tool/subagent row immediately instead
  // of waiting for the whole assistant message (with all its tool inputs) to
  // stream — the gap is most visible for Task calls, whose prompts are large.
  | ({ type: 'tool_call_start'; id: string; name: string } & AgentEventIdentity)
  // `blocked` marks a call rejected by the beforeToolCall permission hook; its
  // input is redacted (null) so blocked inputs never reach the UI.
  | ({
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      blocked?: boolean;
    } & AgentEventIdentity)
  | ({
      type: 'tool_result';
      id: string;
      name: string;
      result: string;
      isError: boolean;
    } & AgentEventIdentity)
  | ({ type: 'todos'; todos: TodoItem[] } & AgentEventIdentity)
  | ({ type: 'compaction'; contextTokens: number } & AgentEventIdentity)
  | ({ type: 'turn_complete'; usage: TokenUsage } & AgentEventIdentity)
  | ({ type: 'error'; message: string } & AgentEventIdentity)
  | ({ type: 'done'; summary: string; usage: TokenUsage } & AgentEventIdentity);
