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
  // Emitted the instant a tool_use block begins streaming, before its input has
  // finished arriving. Lets the UI show the tool/subagent row immediately instead
  // of waiting for the whole assistant message (with all its tool inputs) to
  // stream — the gap is most visible for Task calls, whose prompts are large.
  | ({ type: 'tool_call_start'; id: string; name: string } & AgentEventIdentity)
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
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

export interface DebugLogStatus {
  /** Whether AGENT_DEBUG_LOG is active and has not been stopped this session. */
  active: boolean;
  /** Current or most recent run log filename, once a task has started. */
  fileName: string | null;
}

/**
 * A live snapshot of the app's security posture, assembled fresh on each request
 * from real process state (VFS contents, a disk-write ledger, and a network-egress
 * ledger). Backs the in-app audit panel. Everything here is *self-reported*: it
 * lets a reviewer see what the app believes it is doing, and the README documents
 * how to confirm the same facts independently (strace/lsof/Process Monitor).
 */
export interface AuditReport {
  /** The in-RAM virtual workspace — the only place agent-visible file content lives. */
  workspace: {
    /** Whether a workspace currently exists (a task has run this conversation). */
    active: boolean;
    fileCount: number;
    totalBytes: number;
    /** Count and byte totals split by provenance status. */
    byStatus: Record<FileStatus, { count: number; bytes: number }>;
    maxFileBytes: number;
    maxTotalBytes: number;
  };
  /**
   * Workspace content written to disk this session. This only ever increments
   * through the user-initiated export handlers; a fresh, idle session reads 0.
   */
  disk: {
    writeCount: number;
    bytesWritten: number;
    /** Absolute path of the most recent export, or null if nothing was exported. */
    lastPath: string | null;
  };
  /**
   * Opt-in debug logging (AGENT_DEBUG_LOG). When active, agent events and tool
   * inputs ARE being written to disk — the audit panel must say so.
   */
  debugLog: {
    active: boolean;
    fileName: string | null;
  };
  /**
   * Outbound network egress observed by the guards this session: every main
   * process fetch (globalThis.fetch is replaced with the audited guard, and the
   * SDK client is wired through it) plus the Chromium webRequest layer.
   */
  network: {
    /** The single host outbound requests are permitted to reach. */
    allowedHost: string;
    requestCount: number;
    /** Per-host request tallies (should only ever contain the allowed host). */
    hosts: { host: string; count: number }[];
    /** Hosts other than the allowed one that were attempted and blocked. */
    blockedHosts: string[];
  };
  /** Ephemeral API-key state. The key itself is never included here. */
  apiKey: {
    present: boolean;
  };
}

/** The complete contextBridge surface exposed to the renderer. */
export interface AgentBridge {
  /** Whether an ephemeral API key is currently set in the main process. */
  hasApiKey(): Promise<boolean>;
  /** Provide an API key for this session; held in memory only, never persisted. */
  setApiKey(key: string): Promise<void>;
  /** Discard the in-memory API key. */
  clearApiKey(): Promise<void>;
  /**
   * The ambient ANTHROPIC_API_KEY from the environment (.env), if any, used to
   * pre-fill the key input. Dev-only convenience; null in packaged builds.
   */
  getEnvApiKey(): Promise<string | null>;
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
  /** A live snapshot of the app's security posture (RAM workspace, disk writes, egress). */
  auditReport(): Promise<AuditReport>;
  /**
   * Run a task. If a conversation is already in progress, `task` is sent as a
   * follow-up message that continues it (preserving history and the workspace);
   * otherwise a fresh conversation and workspace are started from the staged files.
   * Resolves once the conversation is fully idle again (including any steered turns).
   */
  startTask(task: string): Promise<void>;
  /**
   * Inject a message into the run that is already in progress; it is picked up at
   * the next turn boundary rather than starting a new run. Resolves as soon as the
   * message is queued (the run continues in the background).
   */
  steer(message: string): Promise<void>;
  cancelTask(): Promise<void>;
  /** Discard the current conversation and workspace so the next task starts fresh. */
  resetConversation(): Promise<void>;
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
