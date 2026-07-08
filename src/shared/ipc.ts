/**
 * Shared type contracts between the main process, preload bridge, and renderer.
 * No runtime code lives here — types only, so it is safe to import from any context.
 */

export type FileStatus = 'provided' | 'created' | 'modified';

export interface StagedFileInfo {
  /** Original absolute path on the user's disk (main-process only knowledge). */
  path: string;
  /** Basename shown to the user. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Provenance: the app's bundled default corpus, or a user-added upload. */
  origin: 'seed' | 'user';
}

export interface WorkspaceFileInfo {
  /** Workspace-relative POSIX path (the VFS key). */
  path: string;
  size: number;
  status: FileStatus;
}

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

/**
 * Streamed agent events, mirrored to the renderer over IPC.
 */
export type AgentEvent =
  | ({ type: 'assistant_text_delta'; text: string } & AgentEventIdentity)
  | ({ type: 'tool_call'; id: string; name: string; input: unknown } & AgentEventIdentity)
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DebugLogStatus {
  /** Whether AGENT_DEBUG_LOG is active and has not been stopped this session. */
  active: boolean;
  /** Current or most recent run log filename, once a task has started. */
  fileName: string | null;
}

/** The complete contextBridge surface exposed to the renderer. */
export interface AgentBridge {
  /** Whether an ephemeral API key is currently set in the main process. */
  hasApiKey(): Promise<boolean>;
  /** Provide an API key for this session; held in memory only, never persisted. */
  setApiKey(key: string): Promise<void>;
  /** Discard the in-memory API key. */
  clearApiKey(): Promise<void>;
  stageFiles(): Promise<StagedFileInfo[]>;
  removeStagedFile(path: string): Promise<StagedFileInfo[]>;
  listStagedFiles(): Promise<StagedFileInfo[]>;
  /** Whether the bundled default corpus is currently included in the workspace. */
  isSeedIncluded(): Promise<boolean>;
  /** Include or exclude the whole default corpus; returns the new state. */
  setSeedIncluded(included: boolean): Promise<boolean>;
  /** Whether opt-in debug logging is active for this session. */
  debugLogStatus(): Promise<DebugLogStatus>;
  /** Disable opt-in debug logging for the rest of the session. */
  stopDebugLog(): Promise<DebugLogStatus>;
  startTask(task: string): Promise<void>;
  cancelTask(): Promise<void>;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  listWorkspaceFiles(): Promise<WorkspaceFileInfo[]>;
  getWorkspaceFile(path: string): Promise<string>;
  exportFile(path: string): Promise<{ saved: boolean; path?: string }>;
  exportAll(): Promise<{ saved: boolean; dir?: string; count?: number }>;
}

declare global {
  interface Window {
    agent: AgentBridge;
  }
}
