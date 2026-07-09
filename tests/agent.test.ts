import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';
import type { EngineRequest } from '../src/main/agent/engine';
import { Agent } from '../src/main/agent/agent';
import { buildTools } from '../src/main/tools/index';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { TokenBudget } from '../src/main/agent/types';
import { createFakeEngine, type FakeEngine } from './fakeEngine';

function makeAgent(events: AgentEvent[] = []): { agent: Agent; engine: FakeEngine } {
  const engine = createFakeEngine();
  const agent = new Agent({
    vfs: new VirtualWorkspace(),
    engine,
    tools: buildTools(),
    budget: new TokenBudget(),
    emit: (e) => events.push(e),
  });
  return { agent, engine };
}

function lastUserText(req: EngineRequest): string {
  const msg = req.messages[req.messages.length - 1];
  const content = msg?.content;
  if (typeof content === 'string') return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

describe('Agent', () => {
  it('runs a prompt when idle and resumes the same conversation on the next prompt', async () => {
    const { agent, engine } = makeAgent();
    engine.push({ text: 'First answer.', stopReason: 'end_turn' });
    engine.push({ text: 'Second answer.', stopReason: 'end_turn' });

    expect(agent.isRunning()).toBe(false);

    agent.prompt('first question');
    expect(agent.isRunning()).toBe(true); // active synchronously
    await agent.waitUntilIdle();
    expect(agent.isRunning()).toBe(false);

    agent.prompt('second question');
    await agent.waitUntilIdle();

    // The second run resumed from the first: prior user+assistant turns, then the
    // new question — three messages, not a fresh one-message conversation.
    const second = engine.requests[1];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[0]?.content).toBe('first question');
    expect(second.messages[1]?.role).toBe('assistant');
    expect(lastUserText(second)).toBe('second question');
  });

  it('injects a steer() into the run already in progress', async () => {
    const { agent, engine } = makeAgent();
    engine.push({ text: 'Working…', stopReason: 'end_turn' });
    engine.push({ text: 'Did the steer too.', stopReason: 'end_turn' });

    agent.prompt('start work');
    // Queued while the run is active; picked up at the stop boundary of the SAME run.
    agent.steer('also handle Y');
    await agent.waitUntilIdle();

    // No new conversation was started — both turns belong to one run, and the
    // second request carried the steering message as a user turn.
    expect(engine.requests).toHaveLength(2);
    const second = engine.requests[1];
    expect(second.messages[0]?.content).toBe('start work');
    expect(lastUserText(second)).toBe('also handle Y');
  });

  it('queues a prompt() sent while busy as a follow-up run', async () => {
    const { agent, engine } = makeAgent();
    engine.push({ text: 'First run done.', stopReason: 'end_turn' });
    engine.push({ text: 'Follow-up run done.', stopReason: 'end_turn' });

    agent.prompt('first task');
    agent.prompt('follow-up task'); // busy → follow-up queue → next run after this one
    await agent.waitUntilIdle();

    // Two distinct runs; the follow-up resumed from the first run's history.
    expect(engine.requests).toHaveLength(2);
    const second = engine.requests[1];
    expect(second.messages).toHaveLength(3);
    expect(lastUserText(second)).toBe('follow-up task');
  });

  it('stop() aborts the active run and drops queued follow-ups', async () => {
    const events: AgentEvent[] = [];
    const { agent, engine } = makeAgent(events);
    // A tool_use turn so the loop reaches an abort check after the first request.
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }],
      stopReason: 'tool_use',
    });
    // A turn that must never be consumed, because the follow-up is cleared.
    engine.push({ text: 'should not run', stopReason: 'end_turn' });

    agent.prompt('do work');
    agent.prompt('queued follow-up');
    agent.stop();
    await agent.waitUntilIdle();

    expect(agent.isRunning()).toBe(false);
    expect(agent.lastRunStatus()).toBe('cancelled');
    // Only the first run's single request went out; the cleared follow-up never ran.
    expect(engine.requests).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('clears leftover steering after a failed run so it cannot leak into the next prompt', async () => {
    const { agent, engine } = makeAgent();
    engine.push({ rejectWith: new Error('boom'), stopReason: 'end_turn' });
    engine.push({ text: 'fresh answer', stopReason: 'end_turn' });

    agent.prompt('first');
    agent.steer('steering that never got a turn boundary');
    await agent.waitUntilIdle();
    expect(agent.lastRunStatus()).toBe('error');

    // A new prompt must start clean — the orphaned steer must not appear.
    agent.prompt('second');
    await agent.waitUntilIdle();

    expect(engine.requests).toHaveLength(2);
    expect(lastUserText(engine.requests[1]!)).toBe('second');
    expect(engine.requests[1]!.messages.some((m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      return text.includes('steering that never');
    })).toBe(false);
  });

  it('clears queued follow-ups after a failed run', async () => {
    const { agent, engine } = makeAgent();
    engine.push({ rejectWith: new Error('boom'), stopReason: 'end_turn' });
    engine.push({ text: 'should be the only recovery turn', stopReason: 'end_turn' });

    agent.prompt('first');
    agent.prompt('follow-up that must die with the failure');
    await agent.waitUntilIdle();
    expect(agent.lastRunStatus()).toBe('error');
    expect(engine.requests).toHaveLength(1);

    agent.prompt('recovery');
    await agent.waitUntilIdle();
    expect(engine.requests).toHaveLength(2);
    expect(lastUserText(engine.requests[1]!)).toBe('recovery');
  });

  it('forwards beforeToolCall from AgentOptions into the loop', async () => {
    const engine = createFakeEngine();
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'x.txt', content: 'no' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'blocked', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const agent = new Agent({
      vfs,
      engine,
      tools: buildTools(),
      budget: new TokenBudget(),
      emit: () => {},
      beforeToolCall: () => ({ block: true, reason: 'policy' }),
    });
    agent.prompt('write');
    await agent.waitUntilIdle();

    expect(vfs.fileCount).toBe(0);
    expect(agent.lastRunStatus()).toBe('completed');
  });
});
