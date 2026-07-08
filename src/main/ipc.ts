import { BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { AgentEvent, StagedFileInfo, WorkspaceFileInfo } from '../shared/ipc';
import { VirtualWorkspace, MAX_FILE_BYTES } from './workspace/VirtualWorkspace';
import { loadSeedCorpus } from './workspace/seedCorpus';
import { sanitizeExportFilename } from './workspace/normalizePath';
import { buildTools } from './tools/index';
import { runAgent } from './agent/loop';
import { TokenBudget } from './agent/types';
import { AGENT_MODEL, hasApiKey, setApiKey, clearApiKey, getEnvApiKey } from './agent/client';
import { debugLogStatus, logEvent, logLine, stopDebugLog } from './debugLog';

/**
 * The persisted root conversation, kept alive between `startTask` calls so the
 * user can send follow-up messages. Holds the full message history, the
 * context-window fill (for the compaction check on resume), and a budget that
 * accumulates token usage across the whole conversation.
 */
interface Conversation {
  messages: MessageParam[];
  contextTokens: number;
  budget: TokenBudget;
}

interface AppState {
  staged: StagedFileInfo[];
  /** Whether the bundled default corpus (origin 'seed') is part of the workspace. */
  seedIncluded: boolean;
  vfs: VirtualWorkspace | null;
  controller: AbortController | null;
  running: boolean;
  /** The active multi-turn conversation, or null before the first task / after reset. */
  conversation: Conversation | null;
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
    controller: null,
    running: false,
    conversation: null,
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

  ipcMain.handle('agent:startTask', async (_e, task: unknown): Promise<void> => {
    const trimmed = requireString(task, 'task').trim();
    if (trimmed.length === 0) throw new Error('Task must not be empty.');
    if (!hasApiKey()) throw new Error('No Anthropic API key set. Enter your key to run a task.');
    if (state.running) throw new Error('A task is already running.');

    // Continue the live conversation when one exists — reusing the same workspace
    // (so the agent's created/modified files persist) and message history. The
    // staged-file set is only sampled when starting fresh; mid-conversation
    // staging changes are intentionally ignored until the next New chat.
    const resuming = state.conversation !== null && state.vfs !== null;
    let vfs: VirtualWorkspace;
    let budget: TokenBudget;

    if (resuming) {
      vfs = state.vfs as VirtualWorkspace;
      budget = (state.conversation as Conversation).budget;
      logLine(
        'run_continue',
        JSON.stringify({ task: trimmed, priorMessages: state.conversation!.messages.length, fileCount: vfs.fileCount }),
      );
    } else {
      // Build a fresh in-memory workspace from the staged files (read-only reads).
      // The default corpus is included only when the seed toggle is on.
      vfs = new VirtualWorkspace();
      for (const file of effectiveStaged(state)) {
        const content = await readFile(file.path);
        vfs.stageProvided(file.name, content);
      }
      budget = new TokenBudget();
      logLine('run_start', JSON.stringify({ task: trimmed, model: AGENT_MODEL, fileCount: vfs.fileCount }));
    }

    const controller = new AbortController();
    state.vfs = vfs;
    state.controller = controller;
    state.running = true;

    try {
      await runAgent({
        task: trimmed,
        tools: buildTools(),
        vfs,
        emit,
        signal: controller.signal,
        depth: 0,
        agentId: 'root',
        parentAgentId: null,
        budget,
        ...(resuming
          ? {
              priorMessages: state.conversation!.messages,
              priorContextTokens: state.conversation!.contextTokens,
            }
          : {}),
        // Persist the completed history so the next task continues this conversation.
        onConversationState: (messages, contextTokens) => {
          state.conversation = { messages, contextTokens, budget };
        },
      });
      logLine('run_end', JSON.stringify({ status: 'completed' }));
    } catch (e) {
      logLine('run_error', JSON.stringify({ message: (e as Error).message ?? String(e) }));
      // runAgent already emitted an 'error' event for the renderer; swallow so
      // the IPC promise settles cleanly.
    } finally {
      state.running = false;
      state.controller = null;
    }
  });

  ipcMain.handle('agent:cancelTask', (): void => {
    state.controller?.abort();
  });

  ipcMain.handle('agent:resetConversation', (): void => {
    if (state.running) throw new Error('Cannot start a new conversation while a task is running.');
    // Drop the history and workspace; the next startTask rebuilds both from the
    // current staged files.
    state.conversation = null;
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
        await writeFile(target, state.vfs.readBuffer(file.path));
        count += 1;
      }
      return { saved: true, dir, count };
    },
  );
}
