import { createApiKeyGate } from './apiKeyGate';
import { createDebugLogView } from './debugLogView';
import { byId, createToast, errorMessage } from './dom';
import { renderLayout } from './layout';
import { createStagingView } from './stagingView';
import { createTranscriptView } from './transcriptView';
import { createWorkspaceView } from './workspaceView';

const agent = window.agent;

renderLayout(byId('app'));

const toast = createToast(byId('toast'));
const taskInput = byId<HTMLTextAreaElement>('task');
const runBtn = byId<HTMLButtonElement>('run');
const cancelBtn = byId<HTMLButtonElement>('cancel');
const newChatBtn = byId<HTMLButtonElement>('new-chat');

let running = false;
let conversationActive = false;

const debugLog = createDebugLogView(
  agent,
  {
    debugLogEl: byId('debug-log'),
    debugLogLabel: byId('debug-log-label'),
    debugLogStopBtn: byId<HTMLButtonElement>('debug-log-stop'),
  },
  toast,
);

const staging = createStagingView(
  agent,
  {
    stagedEl: byId('staged'),
    stagedCountEl: byId('staged-count'),
    addBtn: byId<HTMLButtonElement>('add'),
  },
  toast,
);

const workspace = createWorkspaceView(
  agent,
  {
    workspaceEl: byId('workspace'),
    saveAllBtn: byId<HTMLButtonElement>('save-all'),
    saveFileBtn: byId<HTMLButtonElement>('save-file'),
    viewer: byId('viewer'),
    viewerPath: byId('viewer-path'),
    viewerBody: byId('viewer-body'),
  },
  toast,
);

function updateComposerMode(): void {
  runBtn.textContent = conversationActive ? 'Send' : 'Run';
  taskInput.placeholder = conversationActive
    ? 'Send a follow-up message…'
    : 'Describe the task for the agent…';
  newChatBtn.hidden = !conversationActive;
}

const transcript = createTranscriptView(
  {
    transcriptEl: byId('transcript'),
    rootTodosEl: byId('todos'),
    tokensEl: byId('tokens'),
  },
  {
    onRootDone(): void {
      conversationActive = true;
      updateComposerMode();
    },
    onWorkspaceChanged(): void {
      void workspace.refresh();
    },
  },
);

const apiKeyGate = createApiKeyGate(
  agent,
  {
    gate: byId('gate'),
    gateForm: byId<HTMLFormElement>('gate-form'),
    gateError: byId('gate-error'),
    apiKeyInput: byId<HTMLInputElement>('api-key'),
    changeKeyBtn: byId<HTMLButtonElement>('change-key'),
  },
  toast,
);

function setRunning(next: boolean): void {
  running = next;
  runBtn.disabled = next;
  cancelBtn.disabled = !next;
  newChatBtn.disabled = next;
  staging.setRunning(next);
}

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (task.length === 0) {
    toast.show(conversationActive ? 'Enter a message first.' : 'Enter a task first.', true);
    return;
  }

  if (!conversationActive) transcript.clear();
  transcript.appendUserMessage(task);
  taskInput.value = '';
  setRunning(true);
  await debugLog.refresh();

  try {
    await agent.startTask(task);
  } catch (err) {
    transcript.addBanner(errorMessage(err));
  } finally {
    setRunning(false);
    await debugLog.refresh();
    await workspace.refresh();
  }
});

cancelBtn.addEventListener('click', () => {
  void agent.cancelTask();
});

newChatBtn.addEventListener('click', async () => {
  if (running) return;
  try {
    await agent.resetConversation();
  } catch (err) {
    toast.show(errorMessage(err), true);
    return;
  }
  conversationActive = false;
  transcript.clear();
  transcript.appendIdleHint();
  updateComposerMode();
  workspace.clearSelection();
  await workspace.refresh();
  taskInput.focus();
});

agent.onAgentEvent((event) => {
  debugLog.refreshIfFileNamePending();
  transcript.handleEvent(event);
});

void apiKeyGate.check();
void debugLog.refresh();
void staging.refresh();
