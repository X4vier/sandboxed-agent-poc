import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';

interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use';
  usage?: { input_tokens: number; output_tokens: number };
}

const queue: ScriptedTurn[] = [];
const streamParams: unknown[] = [];
// Mutable so a test can shrink the window to force a compaction pass.
let contextWindowTokens = 200_000;

const fakeClient = {
  messages: {
    stream(params: unknown, _opts: unknown) {
      streamParams.push(params);
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
            usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 },
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
  getContextWindow: () => contextWindowTokens,
  getCompactionThreshold: () => 0.8,
}));

const { runAgent } = await import('../src/main/agent/loop');
const { buildTools } = await import('../src/main/tools/index');
const { VirtualWorkspace } = await import('../src/main/workspace/VirtualWorkspace');
const { TokenBudget } = await import('../src/main/agent/types');

beforeEach(() => {
  queue.length = 0;
  streamParams.length = 0;
  contextWindowTokens = 200_000;
});

describe('runAgent loop', () => {
  it('executes tool calls and returns the final text', async () => {
    queue.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'out.txt', content: 'hi' } }],
      stopReason: 'tool_use',
    });
    queue.push({ text: 'Done. Created out.txt.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const events: AgentEvent[] = [];
    const budget = new TokenBudget();
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
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: '../escape.txt', content: 'x' } }],
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
      budget: new TokenBudget(),
    });

    expect(result).toContain('rejected');
    expect(vfs.fileCount).toBe(0);
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.isError).toBe(true);
  });

  it('compacts history instead of overflowing when the window fills, then continues', async () => {
    // Window of 100 → compaction threshold 80 tokens.
    contextWindowTokens = 100;
    // Turn 1: does a tool call and reports a high context occupancy (> threshold).
    queue.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }],
      stopReason: 'tool_use',
      usage: { input_tokens: 90, output_tokens: 5 },
    });
    // Turn 2 is the summarization pass triggered before the next real turn.
    queue.push({ text: 'SUMMARY: wrote a.txt containing x.', stopReason: 'end_turn' });
    // Turn 3: the real continuation, now on a small compacted context.
    queue.push({ text: 'All done.', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'do the thing',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      budget: new TokenBudget(),
    });

    expect(result).toContain('All done');
    const compaction = events.find((e) => e.type === 'compaction');
    expect(compaction && compaction.type === 'compaction' && compaction.contextTokens).toBe(90);
    expect((streamParams[1] as { tool_choice?: { type: string } }).tool_choice).toEqual({
      type: 'none',
    });
    // Every scripted turn was consumed (tool turn + summary + continuation).
    expect(queue.length).toBe(0);
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
        budget: new TokenBudget(),
      }),
    ).rejects.toThrow();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
