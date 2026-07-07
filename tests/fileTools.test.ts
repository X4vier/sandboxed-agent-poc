import { describe, it, expect } from 'vitest';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  searchFilesTool,
} from '../src/main/tools/fileTools';

function makeCtx(vfs = new VirtualWorkspace()): ToolContext {
  return {
    vfs,
    normalizePath: normalizeWorkspacePath,
    emit: () => {},
    signal: new AbortController().signal,
    attachBlocks: () => {},
  };
}

describe('write_file / read_file', () => {
  it('writes then reads back content', async () => {
    const ctx = makeCtx();
    const w = await writeFileTool.handler({ path: 'a/b.txt', content: 'hello' }, ctx);
    expect(w).toContain('a/b.txt');
    expect(w).toContain('created');
    const r = await readFileTool.handler({ path: 'a/b.txt' }, ctx);
    expect(r).toBe('hello');
  });

  it('reports binary files instead of returning mojibake', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('x.bin', Buffer.from([0xff, 0xfe, 0x00]));
    const r = await readFileTool.handler({ path: 'x.bin' }, ctx);
    expect(r).toMatch(/binary/i);
  });

  it('truncates reads over the cap with a note', async () => {
    const ctx = makeCtx();
    const big = 'x'.repeat(300 * 1024);
    ctx.vfs.stageProvided('big.txt', Buffer.from(big, 'utf-8'));
    const r = await readFileTool.handler({ path: 'big.txt' }, ctx);
    expect(r).toMatch(/\[truncated: showing first \d+ of \d+ bytes\]/);
  });

  it('rejects escaping paths via validation error message', async () => {
    const ctx = makeCtx();
    await expect(writeFileTool.handler({ path: '../evil.txt', content: 'x' }, ctx)).rejects.toThrow();
    expect(ctx.vfs.fileCount).toBe(0);
  });
});

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'f.txt', content: 'the quick brown fox' }, ctx);
    const r = await editFileTool.handler(
      { path: 'f.txt', old_string: 'quick', new_string: 'slow' },
      ctx,
    );
    expect(r).toContain('Replaced 1');
    expect(await readFileTool.handler({ path: 'f.txt' }, ctx)).toBe('the slow brown fox');
  });

  it('fails clearly when old_string is missing', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'f.txt', content: 'abc' }, ctx);
    const r = await editFileTool.handler({ path: 'f.txt', old_string: 'zzz', new_string: 'q' }, ctx);
    expect(r).toMatch(/not found/i);
  });

  it('fails clearly when old_string is ambiguous', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'f.txt', content: 'aa aa aa' }, ctx);
    const r = await editFileTool.handler({ path: 'f.txt', old_string: 'aa', new_string: 'b' }, ctx);
    expect(r).toMatch(/more than once/i);
  });
});

describe('list_files', () => {
  it('lists with status markers and sizes', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('data.csv', Buffer.from('x'));
    await writeFileTool.handler({ path: 'out/summary.md', content: 'yo' }, ctx);
    const r = await listFilesTool.handler({}, ctx);
    expect(r).toContain('[provided]');
    expect(r).toContain('[created]');
    expect(r).toContain('data.csv');
    expect(r).toContain('out/summary.md');
  });

  it('filters by prefix', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'out/a.txt', content: '1' }, ctx);
    await writeFileTool.handler({ path: 'other/b.txt', content: '2' }, ctx);
    const r = await listFilesTool.handler({ path: 'out' }, ctx);
    expect(r).toContain('out/a.txt');
    expect(r).not.toContain('other/b.txt');
  });
});

describe('search_files', () => {
  it('finds substring matches as path:line: text', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'a.txt', content: 'one\ntwo\nthree two' }, ctx);
    const r = await searchFilesTool.handler({ pattern: 'two' }, ctx);
    expect(r).toContain('a.txt:2: two');
    expect(r).toContain('a.txt:3: three two');
  });

  it('supports regex mode', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'a.txt', content: 'foo123\nbar\nbaz456' }, ctx);
    const r = await searchFilesTool.handler({ pattern: '\\d+', is_regex: true }, ctx);
    expect(r).toContain('a.txt:1: foo123');
    expect(r).toContain('a.txt:3: baz456');
    expect(r).not.toContain('bar');
  });

  it('reports invalid regex cleanly', async () => {
    const ctx = makeCtx();
    await writeFileTool.handler({ path: 'a.txt', content: 'x' }, ctx);
    const r = await searchFilesTool.handler({ pattern: '(', is_regex: true }, ctx);
    expect(r).toMatch(/invalid regular expression/i);
  });
});
