import type { AgentEvent, TodoItem, TokenUsage } from '../shared/ipc';
import { el } from './dom';
import { renderMarkdown } from './markdown';

const ROOT_AGENT_ID = 'root';

type ToolStatus = 'running' | 'done' | 'failed';

interface TranscriptElements {
  transcriptEl: HTMLElement;
  rootTodosEl: HTMLElement;
  tokensEl: HTMLElement;
}

interface TranscriptHooks {
  onRootDone(): void;
  onWorkspaceChanged(): void;
}

interface ToolRowState {
  details: HTMLDetailsElement;
  statusEl: HTMLElement;
  summaryEl: HTMLElement;
  metaEl: HTMLElement;
  inputSummary: string;
  taskLabel: string | null;
  startedAt: number;
  isTask: boolean;
  userToggled: boolean;
  settingOpen: boolean;
  hasInput: boolean;
}

export interface TranscriptView {
  addBanner(message: string, agentId?: string, parentAgentId?: string | null): void;
  appendIdleHint(): void;
  appendUserMessage(text: string, steered?: boolean): void;
  clear(): void;
  handleEvent(event: AgentEvent): void;
}

function summarizeInput(input: unknown): string {
  try {
    const text = JSON.stringify(input);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return '';
  }
}

function toolKey(agentId: string, id: string): string {
  return `${agentId}:${id}`;
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

function renderTodoList(todos: TodoItem[]): HTMLElement {
  const box = el('div', 'todo-box');
  box.append(el('div', 'todo-title', 'Plan'));
  const ul = el('ul', 'todo-list');
  for (const todo of todos) {
    const li = el('li', `todo ${todo.status}`);
    const mark = todo.status === 'completed' ? '✔' : todo.status === 'in_progress' ? '▸' : '○';
    const text = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
    li.append(el('span', 'todo-mark', mark), el('span', 'todo-text', text));
    ul.append(li);
  }
  box.append(ul);
  return box;
}

export function createTranscriptView(
  elements: TranscriptElements,
  hooks: TranscriptHooks,
): TranscriptView {
  const { transcriptEl, rootTodosEl, tokensEl } = elements;
  const toolRows = new Map<string, ToolRowState>();
  const agentContainers = new Map<string, HTMLElement>([[ROOT_AGENT_ID, transcriptEl]]);
  const assistantByAgent = new Map<string, { el: HTMLElement; raw: string }>();
  const nestedTodos = new Map<string, HTMLElement>();
  const thinkingByAgent = new Map<string, HTMLElement>();
  const runningToolsByAgent = new Map<string, number>();
  let transcriptPinned = true;

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

  function removeAgentThinking(agentId: string): void {
    const node = thinkingByAgent.get(agentId);
    if (!node) return;
    node.remove();
    thinkingByAgent.delete(agentId);
  }

  function showAgentThinking(agentId: string, parentAgentId: string | null): void {
    if (thinkingByAgent.has(agentId)) return;
    const node = el('div', 'agent-thinking');
    node.append(el('span', 'mini-spinner'), el('span', undefined, 'Thinking…'));
    thinkingByAgent.set(agentId, node);
    containerFor(agentId, parentAgentId).append(node);
    scrollTranscript();
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

  function appendAssistantText(text: string, agentId: string, parentAgentId: string | null): void {
    removeAgentThinking(agentId);
    let current = assistantByAgent.get(agentId);
    if (!current) {
      const node = el('div', 'msg assistant markdown');
      containerFor(agentId, parentAgentId).append(node);
      current = { el: node, raw: '' };
      assistantByAgent.set(agentId, current);
    }
    current.raw += text;
    current.el.replaceChildren(renderMarkdown(current.raw));
    scrollTranscript();
  }

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
    assistantByAgent.delete(agentId);
    const isTask = name === 'Task';
    const details = el('details', 'tool') as HTMLDetailsElement;
    const summary = el('summary');
    const chevronEl = el('span', 'tool-chevron', '›');
    chevronEl.setAttribute('aria-hidden', 'true');
    const statusEl = el('span', 'tool-status running');
    const nameEl = el('span', 'tool-name', isTask ? 'Subagent' : name);
    const summaryEl = el('span', 'tool-summary', 'Preparing…');
    const metaEl = el('span', 'tool-meta', 'running');
    summary.append(chevronEl, statusEl, nameEl, summaryEl, metaEl);
    details.append(summary);

    const row: ToolRowState = {
      details,
      statusEl,
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
    row.summaryEl.textContent = row.isTask ? (label ?? 'Working…') : (label ?? row.inputSummary);
    const inputPre = el('pre', undefined, JSON.stringify(input, null, 2));
    row.details.querySelector('summary')?.after(inputPre);
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

  function setTokens(usage: TokenUsage): void {
    const inputTotal = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    const cached = usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    const cachedPct = inputTotal > 0 ? Math.round((cached / inputTotal) * 100) : 0;
    const cacheNote = cached > 0 ? ` (${cachedPct}% cached)` : '';
    tokensEl.textContent = `tokens: ${inputTotal} in${cacheNote} / ${usage.outputTokens} out / ${usage.totalTokens} total`;
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

  transcriptEl.addEventListener('scroll', updateTranscriptPinned);

  return {
    addBanner,
    appendIdleHint(): void {
      transcriptEl.append(el('div', 'idle-hint', 'Stage files, describe a task, and press Run.'));
    },
    appendUserMessage(text: string, steered = false): void {
      removeAgentThinking(ROOT_AGENT_ID);
      assistantByAgent.delete(ROOT_AGENT_ID);
      const node = el('div', steered ? 'msg user steered' : 'msg user');
      if (steered) {
        // Mark messages injected into a run already in progress, so the transcript
        // reads correctly (they land at the agent's next turn boundary, not now).
        node.append(el('span', 'steer-badge', 'steering'));
      }
      node.append(document.createTextNode(text));
      transcriptEl.append(node);
      transcriptPinned = true;
      forceScrollTranscript();
    },
    clear(): void {
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
    },
    handleEvent(event: AgentEvent): void {
      switch (event.type) {
        case 'assistant_text_delta':
          appendAssistantText(event.text, event.agentId, event.parentAgentId);
          break;
        case 'tool_call_start':
          ensureToolRow(event.id, event.name, event.agentId, event.parentAgentId);
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
          hooks.onWorkspaceChanged();
          break;
        case 'error':
          removeAgentThinking(event.agentId);
          addBanner(event.message, event.agentId, event.parentAgentId);
          break;
        case 'done':
          removeAgentThinking(event.agentId);
          setTokens(event.usage);
          if (event.agentId === ROOT_AGENT_ID) hooks.onRootDone();
          hooks.onWorkspaceChanged();
          break;
      }
    },
  };
}
