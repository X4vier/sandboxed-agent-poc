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
});

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
