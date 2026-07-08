import { createApiKeyGate } from './apiKeyGate';
import { createAuditView } from './auditView';
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

// A prefilled demo task phrased as a natural request for a specific outcome.
// It can't be answered without each country's land borders, so the agent has to
// read all ~190 staged documents (forcing fan-out to Task subagents) and then
// run a graph traversal in the QuickJS sandbox to find the answer.
const DEFAULT_TASK = `I've staged a big set of country profiles in this workspace — one document per country. Here's the puzzle I want solved, using only what the documents actually say:

If I start in one country and travel purely overland — only ever crossing shared land borders, never taking a flight or a boat — what's the largest number of different countries I could visit on a single continuous trip?

Give me the maximum count, the set of countries in that run, and which starting country (or countries) reaches it. Ground every border on the wording in the documents rather than your own memory, and once you have the answer, sanity-check a couple of the border claims by quoting the source text.`;

taskInput.value = DEFAULT_TASK;

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

const audit = createAuditView(
  agent,
  {
    auditEl: byId('audit'),
    auditBody: byId('audit-body'),
    openBtn: byId<HTMLButtonElement>('open-audit'),
    closeBtn: byId<HTMLButtonElement>('audit-close'),
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
  audit.refreshIfOpen();
  transcript.handleEvent(event);
});

void apiKeyGate.check();
void debugLog.refresh();
void staging.refresh();
