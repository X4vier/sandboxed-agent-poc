import type { TodoItem, TodoStatus } from '../../shared/ipc';
import type { AgentTool } from '../agent/types';

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

const MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

/** Parse and validate the todos array arriving from the model as `unknown`. */
function parseTodos(input: unknown): TodoItem[] {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Tool input must be a JSON object.');
  }
  const raw = (input as Record<string, unknown>)['todos'];
  if (!Array.isArray(raw)) {
    throw new Error('Parameter "todos" is required and must be an array.');
  }
  const todos = raw.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`todos[${i}] must be an object with content and status.`);
    }
    const rec = item as Record<string, unknown>;
    const content = rec['content'];
    const status = rec['status'];
    const activeForm = rec['activeForm'];
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error(`todos[${i}].content must be a non-empty string.`);
    }
    if (typeof status !== 'string' || !STATUSES.includes(status as TodoStatus)) {
      throw new Error(`todos[${i}].status must be one of: ${STATUSES.join(', ')}.`);
    }
    if (activeForm !== undefined && typeof activeForm !== 'string') {
      throw new Error(`todos[${i}].activeForm must be a string when provided.`);
    }
    return {
      content,
      status: status as TodoStatus,
      ...(typeof activeForm === 'string' ? { activeForm } : {}),
    };
  });

  const active = todos.filter((t) => t.status === 'in_progress').length;
  if (active > 1) {
    throw new Error('Todo list must not contain more than one in_progress item.');
  }
  if (active === 0 && todos.some((t) => t.status !== 'completed')) {
    throw new Error(
      'Todo list must contain exactly one in_progress item unless every item is completed.',
    );
  }
  return todos;
}

function render(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list cleared.';
  return ['Todos updated:', ...todos.map((t) => `${MARK[t.status]} ${t.content}`)].join('\n');
}

export const todoWriteTool: AgentTool = {
  name: 'TodoWrite',
  description:
    'Record and update your task plan as a checklist the user can watch. Input: ' +
    '{ "todos": [{ "content": "<imperative step>", "status": "pending|in_progress|completed", ' +
    '"activeForm"?: "<present-tense form shown while running>" }] }. ' +
    'You send the ENTIRE list every call — it replaces the previous one, so include every item with ' +
    'its current status. Keep exactly one item in_progress at a time, and flip an item to completed ' +
    'the moment it is finished (do not batch completions). Use this to plan any multi-step task; skip ' +
    'it for trivial single-step work.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full todo list; replaces the previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative description of the step.' },
            status: {
              type: 'string',
              enum: [...STATUSES],
              description: 'pending | in_progress | completed.',
            },
            activeForm: {
              type: 'string',
              description: 'Present-tense form shown while the step is in progress.',
            },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const todos = parseTodos(input);
    ctx.emit({ type: 'todos', todos, depth: ctx.depth });
    return render(todos);
  },
};
