import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';

interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use';
}

const queue: ScriptedTurn[] = [];
const streamParams: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];

const fakeClient = {
  messages: {
    stream(params: { messages: Array<{ role: string; content: unknown }> }, _opts: unknown) {
      streamParams.push(params);
      const turn = queue.shift();
      if (!turn) throw new Error('no scripted turn');
      return {
        on() {
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
  getContextWindow: () => 200_000,
  getCompactionThreshold: () => 0.8,
}));

const { AgentSession } = await import('../src/main/agent/AgentSession');
const { buildTools } = await import('../src/main/tools/index');
const { VirtualWorkspace } = await import('../src/main/workspace/VirtualWorkspace');
const { TokenBudget } = await import('../src/main/agent/types');

function makeSession(events: AgentEvent[] = []) {
  return new AgentSession({
    vfs: new VirtualWorkspace(),
    tools: buildTools(),
    budget: new TokenBudget(),
    emit: (e) => events.push(e),
  });
}

function lastUserText(params: { messages: Array<{ role: string; content: unknown }> }): string {
  const msg = params.messages[params.messages.length - 1];
  const content = msg?.content;
  if (typeof content === 'string') return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

beforeEach(() => {
  queue.length = 0;
  streamParams.length = 0;
});

describe('AgentSession', () => {
  it('runs a prompt when idle and resumes the same conversation on the next prompt', async () => {
    queue.push({ text: 'First answer.', stopReason: 'end_turn' });
    queue.push({ text: 'Second answer.', stopReason: 'end_turn' });

    const session = makeSession();
    expect(session.isRunning()).toBe(false);

    session.prompt('first question');
    expect(session.isRunning()).toBe(true); // active synchronously
    await session.waitUntilIdle();
    expect(session.isRunning()).toBe(false);

    session.prompt('second question');
    await session.waitUntilIdle();

    // The second run resumed from the first: prior user+assistant turns, then the
    // new question — three messages, not a fresh one-message conversation.
    const second = streamParams[1];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]?.content).toBe('first question');
    expect(second.messages[1]?.role).toBe('assistant');
    expect(lastUserText(second)).toBe('second question');
  });

  it('injects a steer() into the run already in progress', async () => {
    queue.push({ text: 'Working…', stopReason: 'end_turn' });
    queue.push({ text: 'Did the steer too.', stopReason: 'end_turn' });

    const session = makeSession();
    session.prompt('start work');
    // Queued while the run is active; picked up at the stop boundary of the SAME run.
    session.steer('also handle Y');
    await session.waitUntilIdle();

    // No new conversation was started — both turns belong to one run, and the
    // second request carried the steering message as a user turn.
    expect(streamParams).toHaveLength(2);
    const second = streamParams[1];
    expect(second.messages[0]?.content).toBe('start work');
    expect(lastUserText(second)).toBe('also handle Y');
  });

  it('queues a prompt() sent while busy as a follow-up run', async () => {
    queue.push({ text: 'First run done.', stopReason: 'end_turn' });
    queue.push({ text: 'Follow-up run done.', stopReason: 'end_turn' });

    const session = makeSession();
    session.prompt('first task');
    session.prompt('follow-up task'); // busy → follow-up queue → next run after this one
    await session.waitUntilIdle();

    // Two distinct runs; the follow-up resumed from the first run's history.
    expect(streamParams).toHaveLength(2);
    const second = streamParams[1];
    expect(second.messages).toHaveLength(3);
    expect(lastUserText(second)).toBe('follow-up task');
  });

  it('stop() aborts the active run and drops queued follow-ups', async () => {
    // A tool_use turn so the loop reaches an abort check after the first request.
    queue.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }],
      stopReason: 'tool_use',
    });
    // A turn that must never be consumed, because the follow-up is cleared.
    queue.push({ text: 'should not run', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const session = makeSession(events);
    session.prompt('do work');
    session.prompt('queued follow-up');
    session.stop();
    await session.waitUntilIdle();

    expect(session.isRunning()).toBe(false);
    // Only the first run's single request went out; the cleared follow-up never ran.
    expect(streamParams).toHaveLength(1);
    expect(queue).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
