import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';
import type { EngineRequest } from '../src/main/agent/engine';
import { runAgent } from '../src/main/agent/loop';
import { buildTools } from '../src/main/tools/index';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { TokenBudget } from '../src/main/agent/types';
import { createFakeEngine, type FakeEngine } from './fakeEngine';

// The loop now consumes an injected CompletionEngine, so the tests drive it with
// the scripted fake engine (tests/fakeEngine.ts) instead of a mocked SDK client.
let engine: FakeEngine;

beforeEach(() => {
  engine = createFakeEngine();
});

function cacheControl(value: unknown): unknown {
  return (value as { cache_control?: unknown }).cache_control;
}

/** The request the loop streamed through the engine for the given turn. */
function paramsAt(index: number): EngineRequest {
  return engine.requests[index];
}

describe('runAgent loop', () => {
  it('executes tool calls and returns the final text', async () => {
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'out.txt', content: 'hi' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'Done. Created out.txt.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const events: AgentEvent[] = [];
    const budget = new TokenBudget();
    const result = await runAgent({
      task: 'write hi to out.txt',
      tools: buildTools(),
      engine,
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
    engine.push({ text: 'First answer.', stopReason: 'end_turn', usage: { input_tokens: 40, output_tokens: 5 } });

    const vfs = new VirtualWorkspace();
    const budget = new TokenBudget();
    let saved: { messages: unknown[]; contextTokens: number } | null = null;
    const base = {
      tools: buildTools(),
      engine,
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
    engine.push({ text: 'Second answer.', stopReason: 'end_turn' });
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
    engine.push({ text: 'Done.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    vfs.stageProvided('kenya.pdf', Buffer.from('x'.repeat(2048)));
    vfs.stageProvided('austria.docx', Buffer.from('y'));

    await runAgent({
      task: 'how many files are there?',
      tools: buildTools(),
      engine,
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
    engine.push({ text: 'Done.', stopReason: 'end_turn' });

    await runAgent({
      task: 'just answer',
      tools: buildTools(),
      engine,
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
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'out.txt', content: 'hi' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'Done.', stopReason: 'end_turn' });

    await runAgent({
      task: 'write hi',
      tools: buildTools(),
      engine,
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
    engine.push({
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
      engine,
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
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: '../escape.txt', content: 'x' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'The write was rejected.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'try to escape',
      tools: buildTools(),
      engine,
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
    engine.contextWindow = 100;
    // Turn 1: does a tool call and reports a high context occupancy (> threshold).
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }],
      stopReason: 'tool_use',
      usage: { input_tokens: 10, cache_read_input_tokens: 80, output_tokens: 5 },
    });
    // Turn 2 is the summarization pass triggered before the next real turn.
    engine.push({ text: 'SUMMARY: wrote a.txt containing x.', stopReason: 'end_turn' });
    // Turn 3: the real continuation, now on a small compacted context.
    engine.push({ text: 'All done.', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'do the thing',
      tools: buildTools(),
      engine,
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
    // The summarization pass forbids tool calls.
    expect(paramsAt(1).toolChoice).toBe('none');
    const compactionParams = paramsAt(1);
    expect(compactionParams.system[0]).toEqual(expect.objectContaining({ cache_control: { type: 'ephemeral' } }));
    expect(compactionParams.tools.at(-1)).toEqual(expect.objectContaining({ cache_control: { type: 'ephemeral' } }));
    const compactionLast = compactionParams.messages.at(-1);
    const compactionBlocks = compactionLast?.content as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(compactionBlocks.at(-1)).toEqual(
      expect.objectContaining({ text: expect.stringContaining('You are about to run out'), cache_control: { type: 'ephemeral' } }),
    );
    // Every scripted turn was consumed (tool turn + summary + continuation).
    expect(engine.requests).toHaveLength(3);
  });

  it('injects a steering message at the stop boundary and keeps going', async () => {
    // Turn 1 wants to stop, but a steering message is queued, so the loop must
    // append it as a fresh user turn and run a second turn instead of finishing.
    engine.push({ text: 'First pass done.', stopReason: 'end_turn' });
    engine.push({ text: 'Now really done.', stopReason: 'end_turn' });

    const pending: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: 'actually also do Y' }];
    let saved: { messages: unknown[] } | null = null;

    const result = await runAgent({
      task: 'do X',
      tools: buildTools(),
      engine,
      vfs: new VirtualWorkspace(),
      emit: () => undefined,
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
      drainSteering: () => pending.splice(0, 1),
      onConversationState: (messages) => {
        saved = { messages };
      },
    });

    // The run did not stop on the first end_turn; it continued and returned the
    // second turn's text.
    expect(result).toBe('Now really done.');
    // The second request carried the steering message as a trailing user turn.
    const second = paramsAt(1);
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]?.content).toBe('do X');
    expect(second.messages[1]?.role).toBe('assistant');
    expect(second.messages[2]?.role).toBe('user');
    const steerBlocks = second.messages[2]?.content as Array<{ type: string; text?: string }>;
    expect(steerBlocks[0]).toMatchObject({ type: 'text', text: 'actually also do Y' });
    // The handed-back history includes the steered turn (user, assistant, user, assistant).
    expect(saved!.messages).toHaveLength(4);
  });

  it('folds a steering message into the tool-result turn', async () => {
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'Handled the tools and the steer.', stopReason: 'end_turn' });

    const pending: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: 'while you work, note Z' }];

    await runAgent({
      task: 'write a.txt',
      tools: buildTools(),
      engine,
      vfs: new VirtualWorkspace(),
      emit: () => undefined,
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
      drainSteering: () => pending.splice(0, 1),
    });

    // The user turn following the assistant's tool call carries BOTH the
    // tool_result and the steering text, in one message (no dangling user turn).
    const second = paramsAt(1);
    const toolTurn = second.messages[2]?.content as Array<{ type: string; text?: string }>;
    expect(toolTurn.some((b) => b.type === 'tool_result')).toBe(true);
    expect(toolTurn.some((b) => b.type === 'text' && b.text === 'while you work, note Z')).toBe(true);
  });

  it('aborts before an API call when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const events: AgentEvent[] = [];
    await expect(
      runAgent({
        task: 'x',
        tools: buildTools(),
        engine,
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
