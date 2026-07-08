/**
 * Shared type contracts between the main process, preload bridge, and renderer.
 * No runtime code lives here — types only, so it is safe to import from any context.
 *
 * The agent events and workspace/staged file descriptors are owned by the
 * extractable core (`src/main/agent`, `src/main/workspace`) and re-exported here
 * for the preload bridge and renderer to consume; the IPC/app-only types
 * (DebugLogStatus, AuditReport, AgentBridge) are defined below. The dependency
 * direction is app → core: the core never imports this file.
 */

import type { AgentEvent } from '../main/agent/events';
import type { FileStatus, WorkspaceFileInfo } from '../main/workspace/VirtualWorkspace';
import type { StagedFileInfo } from '../main/workspace/seedCorpus';

export type {
  AgentEvent,
  AgentEventIdentity,
  TodoItem,
  TodoStatus,
  TokenUsage,
} from '../main/agent/events';
export type { FileStatus, WorkspaceFileInfo } from '../main/workspace/VirtualWorkspace';
export type { StagedFileInfo } from '../main/workspace/seedCorpus';

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
