import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';

interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
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

function cacheControl(value: unknown): unknown {
  return (value as { cache_control?: unknown }).cache_control;
}

function paramsAt(index: number): {
  system: Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{ role: string; content: string | Array<{ type: string; cache_control?: unknown }> }>;
  tools: Array<{ name: string; cache_control?: unknown }>;
  tool_choice?: { type: string };
} {
  return streamParams[index] as ReturnType<typeof paramsAt>;
}

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
      agentId: 'root',
      parentAgentId: null,
      budget,
    });

    expect(result).toContain('Done');
    expect(vfs.readText('out.txt')).toEqual({ ok: true, text: 'hi' });
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ type: 'tool_call', agentId: 'root', parentAgentId: null });
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ type: 'tool_result', agentId: 'root', parentAgentId: null });
    expect(events.find((e) => e.type === 'done')).toMatchObject({
      type: 'done',
      agentId: 'root',
      parentAgentId: null,
    });
    // two turns × (10 in + 5 out)
    expect(budget.used).toBe(30);
  });

  it('resumes a conversation from prior messages on a follow-up', async () => {
    // First turn: a plain answer that establishes the conversation.
    queue.push({ text: 'First answer.', stopReason: 'end_turn', usage: { input_tokens: 40, output_tokens: 5 } });

    const vfs = new VirtualWorkspace();
    const budget = new TokenBudget();
    let saved: { messages: unknown[]; contextTokens: number } | null = null;
    const base = {
      tools: buildTools(),
      vfs,
      emit: () => undefined,
      signal: new AbortController().signal,
      depth: 0 as const,
      agentId: 'root',
      parentAgentId: null,
      budget,
      onConversationState: (messages: unknown[], contextTokens: number) => {
        saved = { messages, contextTokens };
      },
    };

    await runAgent({ ...base, task: 'first question' });

    // The completed history is handed back: user turn + assistant answer.
    expect(saved).not.toBeNull();
    expect(saved!.messages).toHaveLength(2);
    expect(saved!.contextTokens).toBe(40); // input_tokens of the last turn

    // Follow-up: resume from the saved history with a new user message.
    queue.push({ text: 'Second answer.', stopReason: 'end_turn' });
    const result = await runAgent({
      ...base,
      task: 'follow-up question',
      priorMessages: saved!.messages as never,
      priorContextTokens: saved!.contextTokens,
    });

    expect(result).toBe('Second answer.');
    // The follow-up request carried the prior turns plus the new user message.
    const followUp = paramsAt(1);
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[0]?.content).toBe('first question');
    expect(followUp.messages[1]?.role).toBe('assistant');
    const lastContent = followUp.messages[2]?.content as Array<{ type: string; text?: string }>;
    expect(lastContent[0]).toMatchObject({ type: 'text', text: 'follow-up question' });
    // History keeps growing across turns, and usage accumulates in one budget.
    expect(saved!.messages).toHaveLength(4);
    expect(budget.used).toBe(60); // 40+5 first turn, 10+5 second turn
  });

  it('leads the opening turn with a manifest of staged files', async () => {
    queue.push({ text: 'Done.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    vfs.stageProvided('kenya.pdf', Buffer.from('x'.repeat(2048)));
    vfs.stageProvided('austria.docx', Buffer.from('y'));

    await runAgent({
      task: 'how many files are there?',
      tools: buildTools(),
      vfs,
      emit: () => undefined,
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    const opening = paramsAt(0).messages[0]?.content as Array<{ type: string; text: string }>;
    expect(opening).toHaveLength(2);
    expect(opening[0].text).toContain('2 files already staged');
    expect(opening[0].text).toContain('austria.docx (provided, 1 B)');
    expect(opening[0].text).toContain('kenya.pdf (provided, 2.0 KB)');
    // The user's task stays as its own trailing block (the cache breakpoint).
    expect(opening[1].text).toBe('how many files are there?');
  });

  it('does not add a manifest when the workspace is empty', async () => {
    queue.push({ text: 'Done.', stopReason: 'end_turn' });

    await runAgent({
      task: 'just answer',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: () => undefined,
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    const opening = paramsAt(0).messages[0]?.content as Array<{ type: string; text: string }>;
    expect(opening).toHaveLength(1);
    expect(opening[0].text).toBe('just answer');
  });

  it('adds prompt-cache breakpoints without mutating stored history', async () => {
    queue.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'out.txt', content: 'hi' } }],
      stopReason: 'tool_use',
    });
    queue.push({ text: 'Done.', stopReason: 'end_turn' });

    await runAgent({
      task: 'write hi',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: () => undefined,
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    const first = paramsAt(0);
    expect(first.system).toEqual([
      expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral' } }),
    ]);
    expect(first.tools.slice(0, -1).every((tool) => cacheControl(tool) === undefined)).toBe(true);
    expect(first.tools.at(-1)).toEqual(expect.objectContaining({ cache_control: { type: 'ephemeral' } }));
    expect(first.messages[0]?.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'write hi', cache_control: { type: 'ephemeral' } }),
    ]);

    const second = paramsAt(1);
    expect(second.messages[0]?.content).toBe('write hi');
    expect(cacheControl((second.messages[1]?.content as Array<{ type: string }>)[0])).toBeUndefined();
    const finalMessage = second.messages.at(-1);
    expect(Array.isArray(finalMessage?.content)).toBe(true);
    const finalBlocks = finalMessage?.content as Array<{ type: string; cache_control?: unknown }>;
    expect(finalBlocks.at(-1)).toEqual(expect.objectContaining({ cache_control: { type: 'ephemeral' } }));
  });

  it('accumulates cache usage fields in TokenBudget snapshots', async () => {
    queue.push({
      text: 'Done.',
      stopReason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      },
    });

    const budget = new TokenBudget();
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'finish',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget,
    });

    expect(budget.snapshot()).toEqual({
      inputTokens: 100,
      outputTokens: 7,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 50,
      totalTokens: 1057,
    });
    expect(events.find((e) => e.type === 'turn_complete')).toMatchObject({
      usage: {
        inputTokens: 100,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 50,
        outputTokens: 7,
        totalTokens: 1057,
      },
    });
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
      agentId: 'root',
      parentAgentId: null,
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
      usage: { input_tokens: 10, cache_read_input_tokens: 80, output_tokens: 5 },
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
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    expect(result).toContain('All done');
    const compaction = events.find((e) => e.type === 'compaction');
    expect(compaction && compaction.type === 'compaction' && compaction.contextTokens).toBe(90);
    expect(compaction).toMatchObject({ agentId: 'root', parentAgentId: null, depth: 0 });
    expect((streamParams[1] as { tool_choice?: { type: string } }).tool_choice).toEqual({
      type: 'none',
    });
    const compactionParams = paramsAt(1);
    expect(compactionParams.system[0]).toEqual(expect.objectContaining({ cache_control: { type: 'ephemeral' } }));
    expect(compactionParams.tools.at(-1)).toEqual(expect.objectContaining({ cache_control: { type: 'ephemeral' } }));
    const compactionLast = compactionParams.messages.at(-1);
    const compactionBlocks = compactionLast?.content as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(compactionBlocks.at(-1)).toEqual(
      expect.objectContaining({ text: expect.stringContaining('You are about to run out'), cache_control: { type: 'ephemeral' } }),
    );
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
        agentId: 'root',
        parentAgentId: null,
        budget: new TokenBudget(),
      }),
    ).rejects.toThrow();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
