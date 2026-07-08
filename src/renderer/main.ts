import type { AgentEvent, DebugLogStatus, StagedFileInfo, TodoItem, WorkspaceFileInfo } from '../shared/ipc';
import { renderMarkdown } from './markdown';

const agent = window.agent;

// ---------- tiny DOM helpers ----------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return '';
  }
}

// ---------- layout ----------
document.getElementById('app')!.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="seal">Sandboxed</span>
      <h1>In-memory agent workspace</h1>
    </div>
    <div class="topbar-right">
      <div class="debug-log" id="debug-log" hidden>
        <span id="debug-log-label"></span>
        <button id="debug-log-stop" title="Stop debug logging">Stop logging</button>
      </div>
      <div class="tokens" id="tokens">tokens: —</div>
      <button id="change-key" class="ghost" title="Change API key">🔑 Change key</button>
    </div>
  </header>
  <main class="columns">
    <section class="col">
      <h2>Staged files <span class="count" id="staged-count"></span></h2>
      <div class="col-scroll" id="staged"></div>
      <div class="task-area">
        <button id="add">Add files…</button>
        <textarea id="task" placeholder="Describe the task for the agent…"></textarea>
        <div class="task-buttons">
          <button id="run" class="primary">Run</button>
          <button id="cancel" class="danger" disabled>Cancel</button>
          <button id="new-chat" hidden>New chat</button>
        </div>
      </div>
    </section>
    <section class="col">
      <h2>Transcript</h2>
      <div class="todos" id="todos" hidden></div>
      <div class="col-scroll" id="transcript">
        <div class="idle-hint">Stage files, describe a task, and press Run.</div>
      </div>
    </section>
    <section class="col">
      <h2>Workspace</h2>
      <div class="toolbar">
        <button id="save-all" disabled>Save all…</button>
      </div>
      <div class="col-scroll" id="workspace"><div class="empty">No files yet.</div></div>
      <div class="viewer" id="viewer" hidden>
        <div class="viewer-head">
          <span class="path" id="viewer-path"></span>
          <button id="save-file">Save file…</button>
        </div>
        <pre id="viewer-body"></pre>
      </div>
    </section>
  </main>
  <div class="toast" id="toast"></div>
  <div class="gate" id="gate" hidden>
    <form class="gate-card" id="gate-form">
      <h2>Enter your Anthropic API key</h2>
      <p>
        The key is held in memory for this session only — it is never written to
        disk and is discarded when you close the app.
      </p>
      <input
        type="password"
        id="api-key"
        placeholder="sk-ant-…"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="gate-error" id="gate-error" hidden></div>
      <button type="submit" class="primary">Continue</button>
    </form>
  </div>
`;

// ---------- element refs ----------
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stagedEl = $('staged');
const stagedCountEl = $('staged-count');
const transcriptEl = $('transcript');
const rootTodosEl = $('todos');
const workspaceEl = $('workspace');
const tokensEl = $('tokens');
const addBtn = $<HTMLButtonElement>('add');
const runBtn = $<HTMLButtonElement>('run');
const cancelBtn = $<HTMLButtonElement>('cancel');
const newChatBtn = $<HTMLButtonElement>('new-chat');
const saveAllBtn = $<HTMLButtonElement>('save-all');
const saveFileBtn = $<HTMLButtonElement>('save-file');
const taskInput = $<HTMLTextAreaElement>('task');
const viewer = $('viewer');
const viewerPath = $('viewer-path');
const viewerBody = $('viewer-body');
const toast = $('toast');
const gate = $('gate');
const gateForm = $<HTMLFormElement>('gate-form');
const gateError = $('gate-error');
const apiKeyInput = $<HTMLInputElement>('api-key');
const changeKeyBtn = $<HTMLButtonElement>('change-key');
const debugLogEl = $('debug-log');
const debugLogLabel = $('debug-log-label');
const debugLogStopBtn = $<HTMLButtonElement>('debug-log-stop');

let running = false;
// Whether a conversation is live (a task has completed and can take follow-ups).
// Mirrors the main-process `conversation` state; set on the root `done` event,
// cleared on New chat.
let conversationActive = false;
let seedIncluded = true;
let selectedPath: string | null = null;
let debugLogActive = false;
let debugLogFileName: string | null = null;

// ---------- toast ----------
let toastTimer: number | undefined;
function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.className = `toast show${isError ? ' error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.className = 'toast'), 3500);
}

// ---------- debug log ----------
function renderDebugLogStatus(status: DebugLogStatus): void {
  debugLogActive = status.active;
  debugLogFileName = status.fileName;
  debugLogEl.hidden = !status.active;
  debugLogLabel.textContent = status.fileName
    ? `● Debug log: ${status.fileName}`
    : '● Debug log: enabled';
}

async function refreshDebugLogStatus(): Promise<void> {
  renderDebugLogStatus(await agent.debugLogStatus());
}

debugLogStopBtn.addEventListener('click', async () => {
  try {
    renderDebugLogStatus(await agent.stopDebugLog());
  } catch (e) {
    showToast((e as Error).message, true);
  }
});

// ---------- staging ----------
/** One removable file row (used for both user files and default-corpus files). */
function fileRow(f: StagedFileInfo): HTMLElement {
  const row = el('div', 'staged-row');
  row.append(el('span', 'name', f.name), el('span', 'size', fmtBytes(f.size)));
  const x = el('button', 'x', '✕');
  x.title = 'Remove';
  x.disabled = running;
  x.addEventListener('click', async () => {
    renderStaged(await agent.removeStagedFile(f.path));
  });
  row.append(x);
  return row;
}

/**
 * The default corpus as a labelled group with an include/exclude toggle, so
 * it's always clear whether the bundled documents are part of the workspace.
 * The files themselves are tucked into a collapsed list to avoid cluttering
 * the panel with all ~100 rows.
 */
function renderSeedGroup(seed: StagedFileInfo[]): HTMLElement {
  const group = el('div', `seed-group${seedIncluded ? '' : ' excluded'}`);

  const header = el('label', 'seed-toggle');
  const cb = el('input', 'seed-checkbox') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = seedIncluded;
  cb.disabled = running;
  cb.addEventListener('change', async () => {
    seedIncluded = await agent.setSeedIncluded(cb.checked);
    await refreshStaged();
  });
  header.append(cb, el('span', 'seed-title', 'Default documents'), el('span', 'count', `(${seed.length})`));
  group.append(header);

  group.append(
    el(
      'div',
      'seed-caption',
      seedIncluded
        ? 'Bundled country reference docs — included in the workspace'
        : 'Bundled country reference docs — excluded from the workspace',
    ),
  );

  const details = el('details', 'seed-files');
  details.append(el('summary', undefined, `Show ${seed.length} files`));
  for (const f of seed) details.append(fileRow(f));
  group.append(details);
  return group;
}

function renderStaged(files: StagedFileInfo[]): void {
  stagedEl.replaceChildren();
  const seed = files.filter((f) => f.origin === 'seed');
  const user = files.filter((f) => f.origin === 'user');
  const effective = (seedIncluded ? seed.length : 0) + user.length;
  stagedCountEl.textContent = effective > 0 ? `(${effective})` : '';

  if (seed.length === 0 && user.length === 0) {
    stagedEl.append(el('div', 'empty', 'Nothing staged.'));
    return;
  }
  if (seed.length > 0) stagedEl.append(renderSeedGroup(seed));
  for (const f of user) stagedEl.append(fileRow(f));
}

/** Fetch the seed-inclusion flag and the staged list together, then render. */
async function refreshStaged(): Promise<void> {
  const [included, files] = await Promise.all([agent.isSeedIncluded(), agent.listStagedFiles()]);
  seedIncluded = included;
  renderStaged(files);
}

addBtn.addEventListener('click', async () => {
  try {
    renderStaged(await agent.stageFiles());
  } catch (e) {
    showToast((e as Error).message, true);
    renderStaged(await agent.listStagedFiles());
  }
});

// ---------- transcript ----------
// Agent output is routed by stable agent id: root activity flows into the
// transcript column; a subagent spawned via Task renders inside the body of its
// Task row. Depth is kept only as display metadata.
const ROOT_AGENT_ID = 'root';
type ToolStatus = 'running' | 'done' | 'failed';
interface ToolRowState {
  details: HTMLDetailsElement;
  statusEl: HTMLElement;
  nameEl: HTMLElement;
  summaryEl: HTMLElement;
  metaEl: HTMLElement;
  inputSummary: string;
  taskLabel: string | null;
  startedAt: number;
  isTask: boolean;
  userToggled: boolean;
  settingOpen: boolean;
  /** Whether the full tool input has arrived and been rendered yet. */
  hasInput: boolean;
}

const toolRows = new Map<string, ToolRowState>();
const agentContainers = new Map<string, HTMLElement>();
const assistantByAgent = new Map<string, { el: HTMLElement; raw: string }>();
const nestedTodos = new Map<string, HTMLElement>();
const thinkingByAgent = new Map<string, HTMLElement>();
const runningToolsByAgent = new Map<string, number>();
let transcriptPinned = true;

function toolKey(agentId: string, id: string): string {
  return `${agentId}:${id}`;
}

function updateTranscriptPinned(): void {
  const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  transcriptPinned = distance < 64;
}

function scrollTranscript(): void {
  if (transcriptPinned) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  updateTranscriptPinned();
}

function forceScrollTranscript(): void {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  updateTranscriptPinned();
}

function containerFor(agentId: string, parentAgentId: string | null): HTMLElement {
  return (
    agentContainers.get(agentId) ??
    (parentAgentId ? agentContainers.get(parentAgentId) : null) ??
    transcriptEl
  );
}

function clearTranscript(): void {
  transcriptEl.replaceChildren();
  toolRows.clear();
  assistantByAgent.clear();
  nestedTodos.clear();
  thinkingByAgent.clear();
  runningToolsByAgent.clear();
  agentContainers.clear();
  agentContainers.set(ROOT_AGENT_ID, transcriptEl);
  rootTodosEl.hidden = true;
  rootTodosEl.replaceChildren();
  transcriptPinned = true;
  forceScrollTranscript();
}

function taskLabel(input: unknown): string | null {
  return input &&
    typeof input === 'object' &&
    'description' in input &&
    typeof (input as { description?: unknown }).description === 'string'
    ? (input as { description: string }).description.trim() || null
    : null;
}

function compactText(value: string, max = 140): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function durationText(startedAt: number, endedAt = performance.now()): string {
  const ms = Math.max(0, endedAt - startedAt);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function setDetailsOpen(row: ToolRowState, open: boolean): void {
  row.settingOpen = true;
  row.details.open = open;
  window.setTimeout(() => {
    row.settingOpen = false;
  }, 50);
}

function updateToolSummary(row: ToolRowState, status: ToolStatus, result?: string): void {
  row.details.dataset['status'] = status;
  row.statusEl.className = `tool-status ${status}`;
  row.statusEl.textContent = status === 'running' ? '' : status === 'done' ? '✓' : '✗';
  row.metaEl.textContent = status === 'running' ? 'running' : durationText(row.startedAt);
  if (!row.isTask) return;
  const label = row.taskLabel ?? 'Subagent task';
  if (status === 'running') {
    row.summaryEl.textContent = label;
  } else {
    const outcome = status === 'failed' ? 'failed' : 'done';
    row.summaryEl.textContent = result
      ? `${label} — ${outcome} · ${compactText(result)}`
      : `${label} — ${outcome}`;
  }
}

function markAgentToolStarted(agentId: string): void {
  runningToolsByAgent.set(agentId, (runningToolsByAgent.get(agentId) ?? 0) + 1);
  removeAgentThinking(agentId);
}

function markAgentToolFinished(agentId: string, parentAgentId: string | null): void {
  const next = Math.max(0, (runningToolsByAgent.get(agentId) ?? 1) - 1);
  if (next === 0) {
    runningToolsByAgent.delete(agentId);
    showAgentThinking(agentId, parentAgentId);
  } else {
    runningToolsByAgent.set(agentId, next);
  }
}

function showAgentThinking(agentId: string, parentAgentId: string | null): void {
  if (thinkingByAgent.has(agentId)) return;
  const node = el('div', 'agent-thinking');
  node.append(el('span', 'mini-spinner'), el('span', undefined, 'Thinking…'));
  thinkingByAgent.set(agentId, node);
  containerFor(agentId, parentAgentId).append(node);
  scrollTranscript();
}

function removeAgentThinking(agentId: string): void {
  const node = thinkingByAgent.get(agentId);
  if (!node) return;
  node.remove();
  thinkingByAgent.delete(agentId);
}

function appendAssistantText(text: string, agentId: string, parentAgentId: string | null): void {
  removeAgentThinking(agentId);
  let cur = assistantByAgent.get(agentId);
  if (!cur) {
    const node = el('div', 'msg assistant markdown');
    containerFor(agentId, parentAgentId).append(node);
    cur = { el: node, raw: '' };
    assistantByAgent.set(agentId, cur);
  }
  // Markdown needs the full block context, so we keep the raw text and re-render
  // the whole message on each streaming delta.
  cur.raw += text;
  cur.el.replaceChildren(renderMarkdown(cur.raw));
  scrollTranscript();
}

// The user's own message, shown in the transcript so a multi-turn conversation
// reads as a dialogue. Starts a fresh root turn: the next assistant delta opens
// a new block rather than appending to the previous answer.
function appendUserMessage(text: string): void {
  removeAgentThinking(ROOT_AGENT_ID);
  assistantByAgent.delete(ROOT_AGENT_ID);
  const node = el('div', 'msg user');
  node.textContent = text;
  transcriptEl.append(node);
  transcriptPinned = true;
  forceScrollTranscript();
}

// Create (or fetch) the row for a tool call. Called both when a tool_use block
// first opens (input not yet known) and — as a fallback — when the full call
// arrives; the row is built once and reused.
function ensureToolRow(
  id: string,
  name: string,
  agentId: string,
  parentAgentId: string | null,
): ToolRowState {
  const key = toolKey(agentId, id);
  const existing = toolRows.get(key);
  if (existing) return existing;
  markAgentToolStarted(agentId);
  assistantByAgent.delete(agentId); // next assistant text starts a fresh block
  const isTask = name === 'Task';
  const details = el('details', 'tool') as HTMLDetailsElement;
  const summary = el('summary');
  const chevronEl = el('span', 'tool-chevron', '›');
  chevronEl.setAttribute('aria-hidden', 'true');
  const statusEl = el('span', 'tool-status running');
  const nameEl = el('span', 'tool-name', isTask ? 'Subagent' : name);
  // Placeholder until the input finishes streaming (filled in by addToolCall).
  const summaryEl = el('span', 'tool-summary', 'Preparing…');
  const metaEl = el('span', 'tool-meta', 'running');
  summary.append(chevronEl, statusEl, nameEl, summaryEl, metaEl);
  details.append(summary);
  const row: ToolRowState = {
    details,
    statusEl,
    nameEl,
    summaryEl,
    metaEl,
    inputSummary: '',
    taskLabel: null,
    startedAt: performance.now(),
    isTask,
    userToggled: false,
    settingOpen: false,
    hasInput: false,
  };
  details.addEventListener('toggle', () => {
    if (!row.settingOpen) row.userToggled = true;
  });
  details.dataset['status'] = 'running';
  toolRows.set(key, row);
  containerFor(agentId, parentAgentId).append(details);

  if (isTask) {
    // Route the spawned subagent's activity into this row's nested body. The row
    // stays collapsed by default — the summary tells you what the subagent is
    // doing, and the chevron reveals its tool activity on demand.
    details.classList.add('task');
    const body = el('div', 'subagent');
    details.append(body);
    agentContainers.set(id, body);
    assistantByAgent.delete(id);
    nestedTodos.delete(id);
  }
  scrollTranscript();
  return row;
}

function addToolCallStart(
  id: string,
  name: string,
  agentId: string,
  parentAgentId: string | null,
): void {
  ensureToolRow(id, name, agentId, parentAgentId);
}

function addToolCall(
  id: string,
  name: string,
  input: unknown,
  agentId: string,
  parentAgentId: string | null,
): void {
  const row = ensureToolRow(id, name, agentId, parentAgentId);
  if (row.hasInput) return;
  row.hasInput = true;
  const label = taskLabel(input);
  row.taskLabel = label;
  row.inputSummary = summarizeInput(input);
  row.summaryEl.textContent = row.isTask
    ? (label ?? 'Working…')
    : (label ?? row.inputSummary);
  // Insert the input dump right after the summary, above any nested subagent body.
  const inputPre = el('pre', undefined, JSON.stringify(input, null, 2));
  row.details.querySelector('summary')!.after(inputPre);
  scrollTranscript();
}

function addToolResult(
  id: string,
  result: string,
  isError: boolean,
  agentId: string,
  parentAgentId: string | null,
): void {
  const row = toolRows.get(toolKey(agentId, id));
  if (!row) {
    markAgentToolFinished(agentId, parentAgentId);
    return;
  }
  if (isError) row.details.dataset['error'] = 'true';
  updateToolSummary(row, isError ? 'failed' : 'done', result);
  row.details.append(el('pre', 'tool-result', result));
  if (row.isTask && !row.userToggled) setDetailsOpen(row, false);
  markAgentToolFinished(agentId, parentAgentId);
  scrollTranscript();
}

function renderTodoList(todos: TodoItem[]): HTMLElement {
  const box = el('div', 'todo-box');
  box.append(el('div', 'todo-title', 'Plan'));
  const ul = el('ul', 'todo-list');
  for (const t of todos) {
    const li = el('li', `todo ${t.status}`);
    const mark = t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▸' : '○';
    const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    li.append(el('span', 'todo-mark', mark), el('span', 'todo-text', text));
    ul.append(li);
  }
  box.append(ul);
  return box;
}

function updateTodos(todos: TodoItem[], agentId: string, parentAgentId: string | null): void {
  if (agentId === ROOT_AGENT_ID) {
    rootTodosEl.hidden = todos.length === 0;
    rootTodosEl.replaceChildren(renderTodoList(todos));
    return;
  }
  let panel = nestedTodos.get(agentId);
  if (!panel) {
    panel = el('div', 'todos nested');
    containerFor(agentId, parentAgentId).append(panel);
    nestedTodos.set(agentId, panel);
  }
  panel.hidden = todos.length === 0;
  panel.replaceChildren(renderTodoList(todos));
  scrollTranscript();
}

function addBanner(
  message: string,
  agentId = ROOT_AGENT_ID,
  parentAgentId: string | null = null,
): void {
  removeAgentThinking(agentId);
  assistantByAgent.delete(agentId);
  containerFor(agentId, parentAgentId).append(el('div', 'banner', message));
  scrollTranscript();
}

function setTokens(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}): void {
  const inputTotal = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const cached = usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const cachedPct = inputTotal > 0 ? Math.round((cached / inputTotal) * 100) : 0;
  const cacheNote = cached > 0 ? ` (${cachedPct}% cached)` : '';
  tokensEl.textContent = `tokens: ${inputTotal} in${cacheNote} / ${usage.outputTokens} out / ${usage.totalTokens} total`;
}

// ---------- run / cancel ----------
function setRunning(next: boolean): void {
  running = next;
  runBtn.disabled = next;
  cancelBtn.disabled = !next;
  addBtn.disabled = next;
  newChatBtn.disabled = next;
  void refreshStaged();
}

// Reflect whether we're starting a conversation or continuing one in the
// composer's affordances (button label, placeholder, New chat visibility).
function updateComposerMode(): void {
  runBtn.textContent = conversationActive ? 'Send' : 'Run';
  taskInput.placeholder = conversationActive
    ? 'Send a follow-up message…'
    : 'Describe the task for the agent…';
  newChatBtn.hidden = !conversationActive;
}

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (task.length === 0) {
    showToast(conversationActive ? 'Enter a message first.' : 'Enter a task first.', true);
    return;
  }
  // Fresh conversation clears the board; a follow-up keeps the history on screen.
  if (!conversationActive) clearTranscript();
  appendUserMessage(task);
  taskInput.value = '';
  setRunning(true);
  await refreshDebugLogStatus();
  try {
    await agent.startTask(task);
  } catch (e) {
    addBanner((e as Error).message);
  } finally {
    setRunning(false);
    await refreshDebugLogStatus();
    await refreshWorkspace();
  }
});

cancelBtn.addEventListener('click', () => {
  void agent.cancelTask();
});

newChatBtn.addEventListener('click', async () => {
  if (running) return;
  try {
    await agent.resetConversation();
  } catch (e) {
    showToast((e as Error).message, true);
    return;
  }
  conversationActive = false;
  clearTranscript();
  transcriptEl.append(el('div', 'idle-hint', 'Stage files, describe a task, and press Run.'));
  updateComposerMode();
  selectedPath = null;
  viewer.hidden = true;
  await refreshWorkspace();
  taskInput.focus();
});

// ---------- workspace / results ----------
async function refreshWorkspace(): Promise<void> {
  const files = await agent.listWorkspaceFiles();
  renderWorkspace(files);
}

function renderWorkspace(files: WorkspaceFileInfo[]): void {
  workspaceEl.replaceChildren();
  saveAllBtn.disabled = files.length === 0;
  if (files.length === 0) {
    workspaceEl.append(el('div', 'empty', 'No files yet.'));
    return;
  }
  for (const f of files) {
    const row = el('div', 'ws-row');
    if (f.path === selectedPath) row.classList.add('selected');
    row.append(
      el('span', `badge ${f.status}`, f.status),
      el('span', 'name', f.path),
      el('span', 'size', fmtBytes(f.size)),
    );
    row.addEventListener('click', () => void openFile(f.path));
    workspaceEl.append(row);
  }
}

async function openFile(path: string): Promise<void> {
  selectedPath = path;
  try {
    const content = await agent.getWorkspaceFile(path);
    viewer.hidden = false;
    viewerPath.textContent = path;
    viewerBody.textContent = content;
  } catch (e) {
    showToast((e as Error).message, true);
  }
  await refreshWorkspace();
}

saveFileBtn.addEventListener('click', async () => {
  if (!selectedPath) return;
  try {
    const r = await agent.exportFile(selectedPath);
    if (r.saved) showToast(`Saved to ${r.path}`);
  } catch (e) {
    showToast((e as Error).message, true);
  }
});

saveAllBtn.addEventListener('click', async () => {
  try {
    const r = await agent.exportAll();
    if (r.saved) showToast(`Saved ${r.count} file(s) to ${r.dir}`);
  } catch (e) {
    showToast((e as Error).message, true);
  }
});

// ---------- event stream ----------
agent.onAgentEvent((event: AgentEvent) => {
  if (debugLogActive && debugLogFileName === null) void refreshDebugLogStatus();
  switch (event.type) {
    case 'assistant_text_delta':
      appendAssistantText(event.text, event.agentId, event.parentAgentId);
      break;
    case 'tool_call_start':
      addToolCallStart(event.id, event.name, event.agentId, event.parentAgentId);
      break;
    case 'tool_call':
      addToolCall(event.id, event.name, event.input, event.agentId, event.parentAgentId);
      break;
    case 'tool_result':
      addToolResult(event.id, event.result, event.isError, event.agentId, event.parentAgentId);
      break;
    case 'todos':
      updateTodos(event.todos, event.agentId, event.parentAgentId);
      break;
    case 'compaction':
      addBanner(
        `Context compacted (was ~${event.contextTokens.toLocaleString()} tokens) — summarizing history to keep going.`,
        event.agentId,
        event.parentAgentId,
      );
      break;
    case 'turn_complete':
      setTokens(event.usage);
      // Keep the workspace panel live during a run: the VFS is populated at
      // task start and mutated by Write/Edit as the run progresses.
      void refreshWorkspace();
      break;
    case 'error':
      removeAgentThinking(event.agentId);
      addBanner(event.message, event.agentId, event.parentAgentId);
      break;
    case 'done':
      removeAgentThinking(event.agentId);
      setTokens(event.usage);
      // The root run completed cleanly and its history is now persisted — the
      // conversation can take follow-up messages.
      if (event.agentId === ROOT_AGENT_ID) {
        conversationActive = true;
        updateComposerMode();
      }
      void refreshWorkspace();
      break;
  }
});

// ---------- API key gate ----------
async function openGate(): Promise<void> {
  gate.hidden = false;
  gateError.hidden = true;
  apiKeyInput.value = (await agent.getEnvApiKey()) ?? '';
  apiKeyInput.focus();
  apiKeyInput.select();
}

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = apiKeyInput.value.trim();
  if (key.length === 0) {
    gateError.textContent = 'Enter a key to continue.';
    gateError.hidden = false;
    return;
  }
  try {
    await agent.setApiKey(key);
    apiKeyInput.value = '';
    gate.hidden = true;
    showToast('API key set for this session.');
  } catch (err) {
    gateError.textContent = (err as Error).message;
    gateError.hidden = false;
  }
});

changeKeyBtn.addEventListener('click', async () => {
  await agent.clearApiKey();
  await openGate();
});

async function checkApiKey(): Promise<void> {
  if (!(await agent.hasApiKey())) await openGate();
}

// ---------- init ----------
transcriptEl.addEventListener('scroll', updateTranscriptPinned);
void checkApiKey();
void refreshDebugLogStatus();
void refreshStaged();
