import { BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentEvent, AuditReport, FileStatus, StagedFileInfo, WorkspaceFileInfo } from '../shared/ipc';
import {
  VirtualWorkspace,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from './workspace/VirtualWorkspace';
import { auditLedgerSnapshot, recordExportWrite } from './audit';
import { loadSeedCorpus } from './workspace/seedCorpus';
import { sanitizeExportFilename } from './workspace/normalizePath';
import { buildTools } from './tools/index';
import { Agent } from './agent/agent';
import { createAnthropicEngine } from './agent/anthropicEngine';
import { DEFAULT_COMPACTION_SETTINGS } from './agent/compaction';
import { TokenBudget } from './agent/types';
import {
  AGENT_MODEL,
  getCompactionThreshold,
  hasApiKey,
  setApiKey,
  clearApiKey,
  getEnvApiKey,
} from './agent/client';
import { debugLogStatus, logEvent, logLine, stopDebugLog } from './debugLog';

interface AppState {
  staged: StagedFileInfo[];
  /** Whether the bundled default corpus (origin 'seed') is part of the workspace. */
  seedIncluded: boolean;
  vfs: VirtualWorkspace | null;
  /**
   * The live multi-turn conversation, or null before the first task / after reset.
   * The agent owns the transcript, context-window fill, token budget, and run
   * lifecycle; the workspace it operates on is mirrored into `vfs` for the audit
   * and export handlers.
   */
  agent: Agent | null;
}

/** The files that will actually populate the VFS, honouring the seed toggle. */
function effectiveStaged(state: AppState): StagedFileInfo[] {
  return state.staged.filter((f) => f.origin === 'user' || state.seedIncluded);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`IPC parameter "${name}" must be a string.`);
  return value;
}

export function registerIpc(window: BrowserWindow): void {
  // Pre-stage the bundled default corpus (see scripts/seed/) so the agent
  // starts with a rich document set; the user can still remove or add files,
  // or exclude the whole corpus via the UI toggle (seedIncluded).
  const state: AppState = {
    staged: loadSeedCorpus(),
    seedIncluded: true,
    vfs: null,
    agent: null,
  };

  const emit = (event: AgentEvent): void => {
    logEvent(event);
    if (!window.isDestroyed()) window.webContents.send('agent:event', event);
  };

  // API key is held only in the main process memory (see agent/client.ts). The
  // renderer can set, clear, or check presence; the only value it can read back
  // is an ambient env-provided key (dev-only seed), used to pre-fill the input.
  ipcMain.handle('agent:hasApiKey', (): boolean => hasApiKey());

  ipcMain.handle('agent:getEnvApiKey', (): string | null => getEnvApiKey());

  ipcMain.handle('agent:setApiKey', (_e, key: unknown): void => {
    setApiKey(requireString(key, 'key'));
  });

  ipcMain.handle('agent:clearApiKey', (): void => clearApiKey());

  ipcMain.handle('agent:stageFiles', async (): Promise<StagedFileInfo[]> => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Stage files for the agent',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return state.staged;

    const rejected: string[] = [];
    for (const filePath of result.filePaths) {
      if (state.staged.some((f) => f.path === filePath)) continue;
      const info = await stat(filePath);
      if (info.size > MAX_FILE_BYTES) {
        rejected.push(`${basename(filePath)} (${(info.size / (1024 * 1024)).toFixed(0)}MB)`);
        continue;
      }
      state.staged.push({ path: filePath, name: basename(filePath), size: info.size, origin: 'user' });
    }
    if (rejected.length > 0) {
      throw new Error(`Skipped files over the 50MB limit: ${rejected.join(', ')}.`);
    }
    return state.staged;
  });

  ipcMain.handle('agent:removeStagedFile', (_e, path: unknown): StagedFileInfo[] => {
    const p = requireString(path, 'path');
    state.staged = state.staged.filter((f) => f.path !== p);
    return state.staged;
  });

  ipcMain.handle('agent:listStagedFiles', (): StagedFileInfo[] => state.staged);

  ipcMain.handle('agent:isSeedIncluded', (): boolean => state.seedIncluded);

  ipcMain.handle('agent:setSeedIncluded', (_e, included: unknown): boolean => {
    state.seedIncluded = included !== false;
    return state.seedIncluded;
  });

  ipcMain.handle('agent:debugLogStatus', () => debugLogStatus());

  ipcMain.handle('agent:stopDebugLog', () => stopDebugLog());

  // A live snapshot of the security posture for the in-app audit panel. The
  // workspace figures come straight from the current in-RAM VFS; the disk and
  // network figures come from the session ledgers in audit.ts.
  ipcMain.handle('agent:auditReport', (): AuditReport => {
    const empty = { count: 0, bytes: 0 };
    const byStatus: Record<FileStatus, { count: number; bytes: number }> = {
      provided: { ...empty },
      created: { ...empty },
      modified: { ...empty },
    };
    let totalBytes = 0;
    const files = state.vfs?.list() ?? [];
    for (const file of files) {
      totalBytes += file.size;
      byStatus[file.status].count += 1;
      byStatus[file.status].bytes += file.size;
    }
    return {
      workspace: {
        active: state.vfs !== null,
        fileCount: files.length,
        totalBytes,
        byStatus,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
      },
      ...auditLedgerSnapshot(),
      debugLog: debugLogStatus(),
      apiKey: { present: hasApiKey() },
    };
  });

  ipcMain.handle('agent:startTask', async (_e, task: unknown): Promise<void> => {
    const trimmed = requireString(task, 'task').trim();
    if (trimmed.length === 0) throw new Error('Task must not be empty.');
    if (!hasApiKey()) throw new Error('No Anthropic API key set. Enter your key to run a task.');
    if (state.agent?.isRunning()) throw new Error('A task is already running.');

    // A live session continues the same conversation and workspace (the agent's
    // created/modified files persist); starting fresh builds a new in-memory
    // workspace from the staged files. The staged-file set is only sampled when
    // starting fresh; mid-conversation staging changes are ignored until New chat.
    if (!state.agent) {
      // Build a fresh in-memory workspace from the staged files (read-only reads).
      // The default corpus is included only when the seed toggle is on.
      const vfs = new VirtualWorkspace();
      for (const file of effectiveStaged(state)) {
        const content = await readFile(file.path);
        vfs.stageProvided(file.name, content);
      }
      state.vfs = vfs;
      state.agent = new Agent({
        vfs,
        engine: createAnthropicEngine(),
        tools: buildTools(),
        budget: new TokenBudget(),
        // Honour the AGENT_COMPACT_THRESHOLD env override (dev knob); other
        // compaction settings keep their defaults.
        compaction: { ...DEFAULT_COMPACTION_SETTINGS, thresholdFraction: getCompactionThreshold() },
        emit,
      });
      logLine('run_start', JSON.stringify({ task: trimmed, model: AGENT_MODEL, fileCount: vfs.fileCount }));
    } else {
      logLine('run_continue', JSON.stringify({ task: trimmed, fileCount: state.vfs?.fileCount ?? 0 }));
    }

    state.agent.prompt(trimmed);
    // Resolve only once the conversation has come fully to rest, so the renderer's
    // await marks the run finished at the right moment (steering keeps it pending).
    await state.agent.waitUntilIdle();
    logLine('run_end', JSON.stringify({ status: 'completed' }));
  });

  ipcMain.handle('agent:steer', (_e, message: unknown): void => {
    const trimmed = requireString(message, 'message').trim();
    if (trimmed.length === 0) throw new Error('Message must not be empty.');
    if (!state.agent) throw new Error('No active conversation to steer.');
    // Injected into the in-flight run at its next turn boundary. Returns at once;
    // the originating startTask await stays pending until the run settles.
    state.agent.steer(trimmed);
  });

  ipcMain.handle('agent:cancelTask', (): void => {
    state.agent?.stop();
  });

  ipcMain.handle('agent:resetConversation', (): void => {
    if (state.agent?.isRunning()) {
      throw new Error('Cannot start a new conversation while a task is running.');
    }
    // Drop the conversation and workspace; the next startTask rebuilds both from
    // the current staged files.
    state.agent = null;
    state.vfs = null;
  });

  ipcMain.handle('agent:listWorkspaceFiles', (): WorkspaceFileInfo[] => state.vfs?.list() ?? []);

  ipcMain.handle('agent:getWorkspaceFile', (_e, path: unknown): string => {
    const p = requireString(path, 'path');
    if (!state.vfs) throw new Error('No workspace is available.');
    const decoded = state.vfs.readText(p);
    if (!decoded.ok) return `[binary file: ${decoded.size} bytes — not displayable as text]`;
    return decoded.text;
  });

  ipcMain.handle(
    'agent:exportFile',
    async (_e, path: unknown): Promise<{ saved: boolean; path?: string }> => {
      const p = requireString(path, 'path');
      if (!state.vfs) throw new Error('No workspace is available.');
      const content = state.vfs.readBuffer(p); // validates path; throws if missing
      const suggested = sanitizeExportFilename(basename(p));
      const result = await dialog.showSaveDialog(window, {
        title: 'Save file',
        defaultPath: suggested,
      });
      if (result.canceled || !result.filePath) return { saved: false };
      // The ONLY workspace-content disk write, besides exportAll.
      await writeFile(result.filePath, content);
      recordExportWrite(result.filePath, content.length);
      return { saved: true, path: result.filePath };
    },
  );

  ipcMain.handle(
    'agent:exportAll',
    async (): Promise<{ saved: boolean; dir?: string; count?: number }> => {
      if (!state.vfs) throw new Error('No workspace is available.');
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose a folder to save all workspace files',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { saved: false };
      const dir = result.filePaths[0];
      if (!dir) return { saved: false };

      let count = 0;
      for (const file of state.vfs.list()) {
        // file.path is an already-validated, POSIX-relative, safe key.
        const target = join(dir, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        // The ONLY workspace-content disk writes, besides exportFile.
        const bytes = state.vfs.readBuffer(file.path);
        await writeFile(target, bytes);
        recordExportWrite(target, bytes.length);
        count += 1;
      }
      return { saved: true, dir, count };
    },
  );
}
