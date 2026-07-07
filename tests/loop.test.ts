import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';

interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use';
}

const queue: ScriptedTurn[] = [];

const fakeClient = {
  messages: {
    stream(_params: unknown, _opts: unknown) {
      const turn = queue.shift();
      if (!turn) throw new Error('no scripted turn');
      return {
        on(event: string, cb: (delta: string) => void) {
          if (event === 'text' && turn.text) cb(turn.text);
          return this;
        },
        async finalMessage() {
          const content: unknown[] = [];
          if (turn.text) content.push({ type: 'text', text: turn.text, citations: null });
          for (const tu of turn.toolUses ?? []) {
            content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
          }
          return {
            content,
            stop_reason: turn.stopReason,
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      };
    },
  },
};

vi.mock('../src/main/agent/client', () => ({
  AGENT_MODEL: 'test-model',
  getClient: () => fakeClient,
  getEffort: () => 'low',
}));

const { runAgent } = await import('../src/main/agent/loop');
const { buildTools } = await import('../src/main/tools/index');
const { VirtualWorkspace } = await import('../src/main/workspace/VirtualWorkspace');
const { TokenBudget } = await import('../src/main/agent/types');

beforeEach(() => {
  queue.length = 0;
});

describe('runAgent loop', () => {
  it('executes tool calls and returns the final text', async () => {
    queue.push({
      toolUses: [{ id: 't1', name: 'write_file', input: { path: 'out.txt', content: 'hi' } }],
      stopReason: 'tool_use',
    });
    queue.push({ text: 'Done. Created out.txt.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const events: AgentEvent[] = [];
    const budget = new TokenBudget(500_000);
    const result = await runAgent({
      task: 'write hi to out.txt',
      tools: buildTools(),
      vfs,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      budget,
    });

    expect(result).toContain('Done');
    expect(vfs.readText('out.txt')).toEqual({ ok: true, text: 'hi' });
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // two turns × (10 in + 5 out)
    expect(budget.used).toBe(30);
  });

  it('turns a throwing tool into an is_error result without crashing', async () => {
    queue.push({
      toolUses: [{ id: 't1', name: 'write_file', input: { path: '../escape.txt', content: 'x' } }],
      stopReason: 'tool_use',
    });
    queue.push({ text: 'The write was rejected.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'try to escape',
      tools: buildTools(),
      vfs,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      budget: new TokenBudget(500_000),
    });

    expect(result).toContain('rejected');
    expect(vfs.fileCount).toBe(0);
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.isError).toBe(true);
  });

  it('aborts before an API call when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const events: AgentEvent[] = [];
    await expect(
      runAgent({
        task: 'x',
        tools: buildTools(),
        vfs: new VirtualWorkspace(),
        emit: (e) => events.push(e),
        signal: ac.signal,
        depth: 0,
        budget: new TokenBudget(500_000),
      }),
    ).rejects.toThrow();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
