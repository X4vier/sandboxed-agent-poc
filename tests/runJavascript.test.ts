import { describe, it, expect } from 'vitest';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';
import { runJavascriptTool } from '../src/main/tools/runJavascript';

function makeCtx(signal?: AbortSignal, vfs = new VirtualWorkspace()): ToolContext {
  return {
    vfs,
    normalizePath: normalizeWorkspacePath,
    emit: () => {},
    signal: signal ?? new AbortController().signal,
    attachBlocks: () => {},
  };
}

const run = (code: string, ctx: ToolContext): Promise<string> =>
  runJavascriptTool.handler({ code }, ctx);

describe('run_javascript — basics', () => {
  it('returns the completion value', async () => {
    const r = await run('1 + 2', makeCtx());
    expect(r).toContain('Completion value:');
    expect(r).toContain('3');
  });

  it('captures the log transcript', async () => {
    const r = await run('log("hello"); log("world"); 42', makeCtx());
    expect(r).toContain('hello');
    expect(r).toContain('world');
    expect(r).toContain('42');
  });

  it('surfaces thrown errors cleanly', async () => {
    const r = await run('throw new Error("boom")', makeCtx());
    expect(r).toMatch(/Error: boom/);
  });
});

describe('run_javascript — capability sandbox', () => {
  it('has no fetch/require/process/timers', async () => {
    const r = await run(
      'JSON.stringify([typeof fetch, typeof require, typeof process, typeof setTimeout, typeof console])',
      makeCtx(),
    );
    expect(r).toContain('["undefined","undefined","undefined","undefined","undefined"]');
  });
});

describe('run_javascript — host file functions', () => {
  it('reads and writes workspace files', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('in.txt', Buffer.from('data'));
    const r = await run(
      'const c = readFile("in.txt"); writeFile("out.txt", c.toUpperCase()); "done"',
      ctx,
    );
    expect(r).toContain('done');
    expect(ctx.vfs.readText('out.txt')).toEqual({ ok: true, text: 'DATA' });
  });

  it('listFiles returns structured entries', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('a.txt', Buffer.from('x'));
    const r = await run('JSON.stringify(listFiles().map(f => f.path))', ctx);
    expect(r).toContain('a.txt');
  });

  it('host functions enforce the path validator', async () => {
    const ctx = makeCtx();
    const r = await run('readFile("../../etc/passwd")', ctx);
    expect(r).toMatch(/Error:/);
    expect(r).toMatch(/escape|absolute|not/i);
  });
});

describe('run_javascript — limits', () => {
  it('interrupts an infinite loop at the deadline and stays usable', async () => {
    const ctx = makeCtx();
    const r = await run('while(true){}', ctx);
    expect(r).toMatch(/Error:/i);
    // A subsequent run works normally.
    const r2 = await run('"still alive"', makeCtx());
    expect(r2).toContain('still alive');
  }, 40_000);

  it('honors an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await run('1+1', makeCtx(ac.signal));
    expect(r).toMatch(/cancel/i);
  });
});
