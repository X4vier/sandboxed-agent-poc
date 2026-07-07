import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';

interface ScriptedTurn {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use';
  waitFor?: Promise<void>;
  rejectWith?: Error;
  onFinalMessageStart?: () => void;
  onFinalMessageFinish?: () => void;
}

const queue: ScriptedTurn[] = [];
const streamParams: unknown[] = [];

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
          turn.onFinalMessageStart?.();
          try {
            await turn.waitFor;
            if (turn.rejectWith) throw turn.rejectWith;
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
          } finally {
            turn.onFinalMessageFinish?.();
          }
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

const { runAgent } = await import('../src/main/agent/loop');
const { buildTools } = await import('../src/main/tools/index');
const { VirtualWorkspace } = await import('../src/main/workspace/VirtualWorkspace');
const { TokenBudget } = await import('../src/main/agent/types');
const { taskTool, MAX_SUBAGENT_DEPTH } = await import('../src/main/tools/task');
const { normalizeWorkspacePath } = await import('../src/main/workspace/normalizePath');

beforeEach(() => {
  queue.length = 0;
  streamParams.length = 0;
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(reason?: unknown): void;
}

function defer(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(1);
  }
  return predicate();
}

interface ToolResultParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

function lastToolResultBlocks(): ToolResultParam[] {
  for (const params of [...streamParams].reverse()) {
    const { messages } = params as { messages?: Array<{ content: unknown }> };
    for (const message of [...(messages ?? [])].reverse()) {
      if (!Array.isArray(message.content)) continue;
      const blocks = message.content.filter(
        (b): b is ToolResultParam =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'tool_result',
      );
      if (blocks.length > 0) return blocks;
    }
  }
  return [];
}

function lastToolResultIds(): string[] {
  return lastToolResultBlocks().map((b) => b.tool_use_id);
}

describe('Task subagent', () => {
  it('spawns a subagent that shares the workspace and reports back', async () => {
    // Root delegates to a subagent…
    queue.push({
      toolUses: [
        { id: 'r1', name: 'Task', input: { description: 'make file', prompt: 'create out.txt' } },
      ],
      stopReason: 'tool_use',
    });
    // …subagent writes a file…
    queue.push({
      toolUses: [{ id: 's1', name: 'Write', input: { file_path: 'out.txt', content: 'hi' } }],
      stopReason: 'tool_use',
    });
    // …subagent reports…
    queue.push({ text: 'Created out.txt.', stopReason: 'end_turn' });
    // …root wraps up.
    queue.push({ text: 'Subagent finished the job.', stopReason: 'end_turn' });

    const vfs = new VirtualWorkspace();
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'delegate creating out.txt',
      tools: buildTools(),
      vfs,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    // Subagent's writes persist in the shared workspace.
    expect(vfs.readText('out.txt')).toEqual({ ok: true, text: 'hi' });
    expect(result).toContain('Subagent finished');

    // Subagent activity is routed by the Task tool_use id; depth remains display metadata.
    const taskCall = events.find((e) => e.type === 'tool_call' && e.name === 'Task');
    expect(taskCall).toMatchObject({
      type: 'tool_call',
      id: 'r1',
      agentId: 'root',
      parentAgentId: null,
      depth: 0,
    });
    const subWrite = events.find((e) => e.type === 'tool_call' && e.name === 'Write');
    expect(subWrite).toMatchObject({
      type: 'tool_call',
      id: 's1',
      agentId: 'r1',
      parentAgentId: 'root',
      depth: 1,
    });

    // The subagent's report flows back to the root as the Task tool_result.
    const taskResult = events.find((e) => e.type === 'tool_result' && e.name === 'Task');
    expect(taskResult && taskResult.type === 'tool_result' && taskResult.result).toContain(
      'Created out.txt',
    );
    expect(taskResult).toMatchObject({ agentId: 'root', parentAgentId: null, depth: 0 });

    // Exactly one root-level 'done' event (subagents don't emit done).
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    // All four turns billed to the shared budget: 4 × (10 in + 5 out).
    const turnAgents = events
      .filter((e) => e.type === 'turn_complete')
      .map((e) => e.agentId);
    expect(turnAgents).toEqual(['root', 'r1', 'r1', 'root']);
  });

  it('runs multiple Task calls from one turn concurrently and preserves result order', async () => {
    const a = defer();
    const b = defer();
    const started: string[] = [];
    const finished: string[] = [];
    const markStarted = (id: string): void => {
      started.push(id);
    };

    queue.push({
      toolUses: [
        { id: 'r1', name: 'Task', input: { description: 'check a', prompt: 'report A' } },
        { id: 'r2', name: 'Task', input: { description: 'check b', prompt: 'report B' } },
      ],
      stopReason: 'tool_use',
    });
    queue.push({
      text: 'A report',
      stopReason: 'end_turn',
      waitFor: a.promise,
      onFinalMessageStart: () => markStarted('r1'),
      onFinalMessageFinish: () => finished.push('r1'),
    });
    queue.push({
      text: 'B report',
      stopReason: 'end_turn',
      waitFor: b.promise,
      onFinalMessageStart: () => markStarted('r2'),
      onFinalMessageFinish: () => finished.push('r2'),
    });
    queue.push({ text: 'Root saw both reports.', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const run = runAgent({
      task: 'fan out',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    const overlapped = await waitUntil(() => started.length === 2);
    if (!overlapped) {
      a.resolve();
      b.resolve();
      await run.catch(() => undefined);
    }
    expect(overlapped).toBe(true);
    expect(started).toEqual(['r1', 'r2']);

    b.resolve();
    expect(await waitUntil(() => finished.length === 1)).toBe(true);
    expect(finished).toEqual(['r2']);

    a.resolve();
    const result = await run;
    expect(result).toContain('Root saw both reports');
    expect(finished).toEqual(['r2', 'r1']);

    const taskResults = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.name === 'Task',
    );
    expect(taskResults.map((e) => e.id)).toEqual(['r2', 'r1']);
    expect(taskResults.every((e) => e.agentId === 'root' && e.parentAgentId === null)).toBe(true);

    const childTurns = events
      .filter((e) => e.type === 'turn_complete' && e.depth === 1)
      .map((e) => e.agentId);
    expect(childTurns).toEqual(['r2', 'r1']);
    expect(lastToolResultIds()).toEqual(['r1', 'r2']);
  });

  it('returns an error result for one failed parallel subagent while its sibling succeeds', async () => {
    queue.push({
      toolUses: [
        { id: 'r1', name: 'Task', input: { description: 'good', prompt: 'succeed' } },
        { id: 'r2', name: 'Task', input: { description: 'bad', prompt: 'fail' } },
      ],
      stopReason: 'tool_use',
    });
    queue.push({ text: 'Successful report.', stopReason: 'end_turn' });
    queue.push({ stopReason: 'end_turn', rejectWith: new Error('subagent boom') });
    queue.push({ text: 'Root handled the mixed results.', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'fan out with failure',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });

    expect(result).toContain('mixed results');
    const blocks = lastToolResultBlocks();
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['r1', 'r2']);
    expect(blocks[0]).toMatchObject({ content: 'Successful report.' });
    expect(blocks[1]).toMatchObject({
      content: 'Error: subagent boom',
      is_error: true,
    });

    const failedEvent = events.find(
      (e) => e.type === 'tool_result' && e.name === 'Task' && e.id === 'r2',
    );
    expect(failedEvent).toMatchObject({
      agentId: 'root',
      parentAgentId: null,
      isError: true,
      result: 'Error: subagent boom',
    });
  });

  it('rejects the root run cleanly when cancelled during parallel Task fan-out', async () => {
    const a = defer();
    const b = defer();
    const started: string[] = [];
    const ac = new AbortController();

    queue.push({
      toolUses: [
        { id: 'r1', name: 'Task', input: { description: 'wait a', prompt: 'wait A' } },
        { id: 'r2', name: 'Task', input: { description: 'wait b', prompt: 'wait B' } },
      ],
      stopReason: 'tool_use',
    });
    queue.push({
      text: 'A report',
      stopReason: 'end_turn',
      waitFor: a.promise,
      onFinalMessageStart: () => started.push('r1'),
    });
    queue.push({
      text: 'B report',
      stopReason: 'end_turn',
      waitFor: b.promise,
      onFinalMessageStart: () => started.push('r2'),
    });

    const events: AgentEvent[] = [];
    const run = runAgent({
      task: 'fan out then cancel',
      tools: buildTools(),
      vfs: new VirtualWorkspace(),
      emit: (e) => events.push(e),
      signal: ac.signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
    });
    const observedRun = run.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    const overlapped = await waitUntil(() => started.length === 2);
    if (!overlapped) {
      a.reject(new Error('cleanup'));
      b.reject(new Error('cleanup'));
      await run.catch(() => undefined);
    }
    expect(overlapped).toBe(true);

    ac.abort();
    a.reject(new Error('aborted A'));
    b.reject(new Error('aborted B'));
    const outcome = await observedRun;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect((outcome.error as Error).message).toMatch(/Run cancelled/);
    }

    expect(events.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: 'Run cancelled.',
      agentId: 'root',
    });
  });

  it('refuses to spawn past the maximum nesting depth', async () => {
    let spawned = false;
    const r = await taskTool.handler(
      { description: 'nested', prompt: 'do stuff' },
      {
        vfs: new VirtualWorkspace(),
        normalizePath: normalizeWorkspacePath,
        emit: () => {},
        signal: new AbortController().signal,
        attachBlocks: () => {},
        depth: MAX_SUBAGENT_DEPTH,
        agentId: 'root',
        parentAgentId: null,
        runSubagent: async () => {
          spawned = true;
          return 'should not run';
        },
      },
    );
    expect(spawned).toBe(false);
    expect(r).toMatch(/maximum nesting depth/i);
  });

  it('rejects an empty subagent prompt', async () => {
    await expect(
      taskTool.handler(
        { description: 'nested', prompt: '   ' },
        {
          vfs: new VirtualWorkspace(),
          normalizePath: normalizeWorkspacePath,
          emit: () => {},
          signal: new AbortController().signal,
          attachBlocks: () => {},
          depth: 0,
          agentId: 'root',
          parentAgentId: null,
          runSubagent: async () => 'should not run',
        },
      ),
    ).rejects.toThrow(/prompt/);
  });
});
