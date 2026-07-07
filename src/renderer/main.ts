import type { AgentEvent, StagedFileInfo, TodoItem, WorkspaceFileInfo } from '../shared/ipc';
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
      <button type="submit" class="primary">Save key</button>
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

let running = false;
let seedIncluded = true;
let selectedPath: string | null = null;

// ---------- toast ----------
let toastTimer: number | undefined;
function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.className = `toast show${isError ? ' error' : ''}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.className = 'toast'), 3500);
}

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
// Agent output is nested by depth: root activity (depth 0) flows into the
// transcript column; a subagent spawned via Task (depth > 0) renders inside the
// body of its Task row. `depthContainers` maps a depth to the element its events
// append to; `assistantByDepth` tracks the streaming assistant block per depth.
const toolRows = new Map<string, HTMLDetailsElement>();
const depthContainers = new Map<number, HTMLElement>();
const assistantByDepth = new Map<number, { el: HTMLElement; raw: string }>();
const nestedTodos = new Map<number, HTMLElement>();

function toolKey(depth: number, id: string): string {
  return `${depth}:${id}`;
}

function scrollTranscript(): void {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function containerFor(depth: number): HTMLElement {
  return depthContainers.get(depth) ?? transcriptEl;
}

function clearNestedRouting(fromDepth: number): void {
  for (const depth of [...depthContainers.keys()]) {
    if (depth >= fromDepth) depthContainers.delete(depth);
  }
  for (const depth of [...assistantByDepth.keys()]) {
    if (depth >= fromDepth) assistantByDepth.delete(depth);
  }
  for (const depth of [...nestedTodos.keys()]) {
    if (depth >= fromDepth) nestedTodos.delete(depth);
  }
}

function clearTranscript(): void {
  transcriptEl.replaceChildren();
  toolRows.clear();
  assistantByDepth.clear();
  nestedTodos.clear();
  depthContainers.clear();
  depthContainers.set(0, transcriptEl);
  rootTodosEl.hidden = true;
  rootTodosEl.replaceChildren();
}

function appendAssistantText(text: string, depth: number): void {
  let cur = assistantByDepth.get(depth);
  if (!cur) {
    const node = el('div', 'msg assistant markdown');
    containerFor(depth).append(node);
    cur = { el: node, raw: '' };
    assistantByDepth.set(depth, cur);
  }
  // Markdown needs the full block context, so we keep the raw text and re-render
  // the whole message on each streaming delta.
  cur.raw += text;
  cur.el.replaceChildren(renderMarkdown(cur.raw));
  scrollTranscript();
}

function addToolCall(id: string, name: string, input: unknown, depth: number): void {
  assistantByDepth.delete(depth); // next assistant text starts a fresh block
  const details = el('details', 'tool') as HTMLDetailsElement;
  const summary = el('summary');
  summary.append(el('span', 'tool-name', name), el('span', 'tool-summary', summarizeInput(input)));
  const inputPre = el('pre', undefined, JSON.stringify(input, null, 2));
  details.append(summary, inputPre);
  toolRows.set(toolKey(depth, id), details);
  containerFor(depth).append(details);

  if (name === 'Task') {
    // Route the spawned subagent's activity into this row's nested body.
    clearNestedRouting(depth + 1);
    details.open = true;
    details.classList.add('task');
    const body = el('div', 'subagent');
    details.append(body);
    depthContainers.set(depth + 1, body);
    assistantByDepth.delete(depth + 1);
    nestedTodos.delete(depth + 1);
  }
  scrollTranscript();
}

function addToolResult(id: string, result: string, isError: boolean, depth: number): void {
  const details = toolRows.get(toolKey(depth, id));
  if (!details) return;
  if (isError) details.dataset['error'] = 'true';
  details.append(el('pre', undefined, result));
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

function updateTodos(todos: TodoItem[], depth: number): void {
  if (depth === 0) {
    rootTodosEl.hidden = todos.length === 0;
    rootTodosEl.replaceChildren(renderTodoList(todos));
    return;
  }
  let panel = nestedTodos.get(depth);
  if (!panel) {
    panel = el('div', 'todos nested');
    containerFor(depth).append(panel);
    nestedTodos.set(depth, panel);
  }
  panel.hidden = todos.length === 0;
  panel.replaceChildren(renderTodoList(todos));
  scrollTranscript();
}

function addBanner(message: string): void {
  assistantByDepth.delete(0);
  transcriptEl.append(el('div', 'banner', message));
  scrollTranscript();
}

function setTokens(usage: { inputTokens: number; outputTokens: number; totalTokens: number }): void {
  tokensEl.textContent = `tokens: ${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.totalTokens} total`;
}

// ---------- run / cancel ----------
function setRunning(next: boolean): void {
  running = next;
  runBtn.disabled = next;
  cancelBtn.disabled = !next;
  addBtn.disabled = next;
  taskInput.disabled = next;
  void refreshStaged();
}

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (task.length === 0) {
    showToast('Enter a task first.', true);
    return;
  }
  clearTranscript();
  setRunning(true);
  try {
    await agent.startTask(task);
  } catch (e) {
    addBanner((e as Error).message);
  } finally {
    setRunning(false);
    await refreshWorkspace();
  }
});

cancelBtn.addEventListener('click', () => {
  void agent.cancelTask();
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
  switch (event.type) {
    case 'assistant_text_delta':
      appendAssistantText(event.text, event.depth);
      break;
    case 'tool_call':
      addToolCall(event.id, event.name, event.input, event.depth);
      break;
    case 'tool_result':
      addToolResult(event.id, event.result, event.isError, event.depth);
      break;
    case 'todos':
      updateTodos(event.todos, event.depth);
      break;
    case 'compaction':
      addBanner(
        `Context compacted (was ~${event.contextTokens.toLocaleString()} tokens) — summarizing history to keep going.`,
      );
      break;
    case 'turn_complete':
      setTokens(event.usage);
      break;
    case 'error':
      addBanner(event.message);
      break;
    case 'done':
      setTokens(event.usage);
      void refreshWorkspace();
      break;
  }
});

// ---------- API key gate ----------
function openGate(): void {
  gate.hidden = false;
  gateError.hidden = true;
  apiKeyInput.value = '';
  apiKeyInput.focus();
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
  openGate();
});

async function checkApiKey(): Promise<void> {
  if (!(await agent.hasApiKey())) openGate();
}

// ---------- init ----------
void checkApiKey();
void refreshStaged();
