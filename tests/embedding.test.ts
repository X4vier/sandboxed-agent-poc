import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// The imports below are the whole point of this file: it reaches ONLY into the
// extractable core (agent / tools / workspace) and the test-side fake engine —
// never into src/main/ipc.ts, src/main/agent/client.ts, src/shared, src/preload,
// or src/renderer. If an embedder can run this, the decoupling holds.
import { runAgent } from '../src/main/agent/loop';
import { Agent } from '../src/main/agent/agent';
import { buildTools } from '../src/main/tools/index';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { TokenBudget } from '../src/main/agent/types';
import type { AgentEvent } from '../src/main/agent/events';
import { createFakeEngine } from './fakeEngine';

describe('embedding the core', () => {
  it('runs runAgent end-to-end with a consumer-supplied engine, tools, workspace, and event sink', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('input.txt', Buffer.from('source data', 'utf-8'));

    const engine = createFakeEngine();
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'out.txt', content: 'derived' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'Wrote out.txt.', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'derive out.txt from input.txt',
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

    expect(result).toContain('Wrote out.txt');
    expect(vfs.readText('out.txt')).toEqual({ ok: true, text: 'derived' });
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('drives the stateful Agent with the same injected engine', async () => {
    const engine = createFakeEngine();
    engine.push({ text: 'Answer.', stopReason: 'end_turn' });

    const events: AgentEvent[] = [];
    const agent = new Agent({
      vfs: new VirtualWorkspace(),
      engine,
      tools: buildTools(),
      budget: new TokenBudget(),
      emit: (e) => events.push(e),
    });
    agent.prompt('question');
    await agent.waitUntilIdle();

    expect(agent.isRunning()).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('exposes the permission seam (beforeToolCall) to embedders', async () => {
    const vfs = new VirtualWorkspace();
    const engine = createFakeEngine();
    engine.push({
      toolUses: [{ id: 't1', name: 'Write', input: { file_path: 'x.txt', content: 'no' } }],
      stopReason: 'tool_use',
    });
    engine.push({ text: 'ok', stopReason: 'end_turn' });

    await runAgent({
      task: 'attempt a write',
      tools: buildTools(),
      engine,
      vfs,
      emit: () => {},
      signal: new AbortController().signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: new TokenBudget(),
      beforeToolCall: () => ({ block: true, reason: 'denied by embedder policy' }),
    });

    // The embedder's policy blocked the write.
    expect(vfs.fileCount).toBe(0);
  });
});

describe('core dependency direction (app -> core, never core -> app)', () => {
  const CORE_ROOTS = [
    'src/main/agent',
    'src/main/tools',
    'src/main/workspace',
    'src/main/documents',
  ];

  function coreFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) out.push(full);
      }
    };
    for (const root of CORE_ROOTS) walk(root);
    return out;
  }

  // Match only real import/export-from specifiers, not prose in comments.
  const importFrom = /(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]/g;

  it('no core module imports the app/IPC layer (shared, ipc, preload, renderer)', () => {
    const forbidden = /(\/shared\/|\/ipc$|\/ipc\.|preload|renderer)/;
    const offenders: string[] = [];
    for (const file of coreFiles()) {
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(importFrom)) {
        if (forbidden.test(m[1])) offenders.push(`${file} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the embeddable core is Electron-free (seedCorpus is app glue and excluded)', () => {
    // seedCorpus.ts loads the app's bundled default corpus via electron.app; it is
    // app glue, not part of the core an embedder would use (they stage their own
    // files). Everything else must not pull Electron in.
    const offenders: string[] = [];
    for (const file of coreFiles()) {
      if (file.endsWith('seedCorpus.ts')) continue;
      const src = readFileSync(file, 'utf-8');
      for (const m of src.matchAll(importFrom)) {
        if (m[1] === 'electron') offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
