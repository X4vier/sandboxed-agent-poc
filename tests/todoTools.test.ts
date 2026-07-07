import { describe, it, expect } from 'vitest';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';
import type { AgentEvent } from '../src/shared/ipc';
import { todoWriteTool } from '../src/main/tools/todoTools';

function makeCtx(events: AgentEvent[], depth = 0): ToolContext {
  return {
    vfs: new VirtualWorkspace(),
    normalizePath: normalizeWorkspacePath,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    attachBlocks: () => {},
    depth,
    runSubagent: async () => '',
  };
}

describe('TodoWrite', () => {
  it('emits a todos event and echoes the list', async () => {
    const events: AgentEvent[] = [];
    const r = await todoWriteTool.handler(
      {
        todos: [
          { content: 'Read the CSV', status: 'completed' },
          { content: 'Convert to JSON', status: 'in_progress', activeForm: 'Converting to JSON' },
          { content: 'Write output', status: 'pending' },
        ],
      },
      makeCtx(events),
    );
    expect(r).toContain('[x] Read the CSV');
    expect(r).toContain('[~] Convert to JSON');
    expect(r).toContain('[ ] Write output');

    const todoEvent = events.find((e) => e.type === 'todos');
    expect(todoEvent && todoEvent.type === 'todos' && todoEvent.todos.length).toBe(3);
    expect(todoEvent && todoEvent.type === 'todos' && todoEvent.depth).toBe(0);
  });

  it('carries the agent depth on the emitted event', async () => {
    const events: AgentEvent[] = [];
    await todoWriteTool.handler(
      { todos: [{ content: 'x', status: 'in_progress' }] },
      makeCtx(events, 2),
    );
    const todoEvent = events.find((e) => e.type === 'todos');
    expect(todoEvent && todoEvent.type === 'todos' && todoEvent.depth).toBe(2);
  });

  it('allows a fully completed list', async () => {
    const events: AgentEvent[] = [];
    const r = await todoWriteTool.handler(
      {
        todos: [
          { content: 'Read the CSV', status: 'completed' },
          { content: 'Write output', status: 'completed' },
        ],
      },
      makeCtx(events),
    );
    expect(r).toContain('[x] Read the CSV');
    expect(events).toHaveLength(1);
  });

  it('rejects an invalid status', async () => {
    const events: AgentEvent[] = [];
    await expect(
      todoWriteTool.handler({ todos: [{ content: 'x', status: 'done' }] }, makeCtx(events)),
    ).rejects.toThrow(/status/);
  });

  it('rejects a non-array todos field', async () => {
    const events: AgentEvent[] = [];
    await expect(todoWriteTool.handler({ todos: 'nope' }, makeCtx(events))).rejects.toThrow(/array/);
  });

  it('rejects multiple in-progress items', async () => {
    const events: AgentEvent[] = [];
    await expect(
      todoWriteTool.handler(
        {
          todos: [
            { content: 'Read input', status: 'in_progress' },
            { content: 'Write output', status: 'in_progress' },
          ],
        },
        makeCtx(events),
      ),
    ).rejects.toThrow(/more than one/);
  });

  it('rejects a non-completed list with no in-progress item', async () => {
    const events: AgentEvent[] = [];
    await expect(
      todoWriteTool.handler(
        {
          todos: [
            { content: 'Read input', status: 'completed' },
            { content: 'Write output', status: 'pending' },
          ],
        },
        makeCtx(events),
      ),
    ).rejects.toThrow(/exactly one/);
  });
});
