import { describe, it, expect } from 'vitest';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';
import {
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  listFilesTool,
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

describe('Write / Read', () => {
  it('writes then reads back content in cat -n form', async () => {
    const ctx = makeCtx();
    const w = await writeTool.handler({ file_path: 'a/b.txt', content: 'hello\nworld' }, ctx);
    expect(w).toContain('a/b.txt');
    expect(w).toContain('created');
    const r = await readTool.handler({ file_path: 'a/b.txt' }, ctx);
    expect(r).toBe('     1\thello\n     2\tworld');
  });

  it('reports an empty file', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'empty.txt', content: '' }, ctx);
    const r = await readTool.handler({ file_path: 'empty.txt' }, ctx);
    expect(r).toMatch(/empty file/i);
  });

  it('reports binary files instead of returning mojibake', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('x.bin', Buffer.from([0xff, 0xfe, 0x00]));
    const r = await readTool.handler({ file_path: 'x.bin' }, ctx);
    expect(r).toMatch(/binary/i);
  });

  it('pages large files with offset/limit and a resume note', async () => {
    const ctx = makeCtx();
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    ctx.vfs.stageProvided('big.txt', Buffer.from(lines, 'utf-8'));
    const first = await readTool.handler({ file_path: 'big.txt', limit: 10 }, ctx);
    expect(first).toContain('     1\tline 1');
    expect(first).toContain('    10\tline 10');
    expect(first).not.toContain('line 11');
    expect(first).toMatch(/offset=11 to continue/);

    const second = await readTool.handler({ file_path: 'big.txt', offset: 11, limit: 10 }, ctx);
    expect(second).toContain('    11\tline 11');
    expect(second).not.toContain('line 1\n');
  });

  it('caps absurdly long single lines', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('min.js', Buffer.from('x'.repeat(5000), 'utf-8'));
    const r = await readTool.handler({ file_path: 'min.js' }, ctx);
    expect(r).toMatch(/line truncated/);
    expect(r.length).toBeLessThan(5000);
  });

  it('suggests near matches on a missing file', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'report.txt', content: 'x' }, ctx);
    const r = await readTool.handler({ file_path: 'reprot.txt' }, ctx);
    expect(r).toMatch(/does not exist/i);
    expect(r).toMatch(/Did you mean.*report\.txt/);
  });

  it('rejects escaping paths via validation error message', async () => {
    const ctx = makeCtx();
    await expect(
      writeTool.handler({ file_path: '../evil.txt', content: 'x' }, ctx),
    ).rejects.toThrow();
    expect(ctx.vfs.fileCount).toBe(0);
  });
});

describe('Edit', () => {
  it('replaces a unique occurrence', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'f.txt', content: 'the quick brown fox' }, ctx);
    const r = await editTool.handler(
      { file_path: 'f.txt', old_string: 'quick', new_string: 'slow' },
      ctx,
    );
    expect(r).toContain('Replaced 1 occurrence');
    const back = ctx.vfs.readText('f.txt');
    expect(back.ok && back.text).toBe('the slow brown fox');
  });

  it('fails clearly when old_string is missing', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'f.txt', content: 'abc' }, ctx);
    const r = await editTool.handler(
      { file_path: 'f.txt', old_string: 'zzz', new_string: 'q' },
      ctx,
    );
    expect(r).toBe(
      'String to replace not found in file. Read the file to copy the exact text (including whitespace) you want to replace.',
    );
  });

  it('fails clearly when old_string is ambiguous and replace_all is false', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'f.txt', content: 'aa aa aa' }, ctx);
    const r = await editTool.handler({ file_path: 'f.txt', old_string: 'aa', new_string: 'b' }, ctx);
    expect(r).toMatch(/Found 3 matches.*replace_all is false/);
  });

  it('replaces every occurrence with replace_all', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'f.txt', content: 'aa aa aa' }, ctx);
    const r = await editTool.handler(
      { file_path: 'f.txt', old_string: 'aa', new_string: 'b', replace_all: true },
      ctx,
    );
    expect(r).toContain('Replaced 3 occurrences');
    const back = ctx.vfs.readText('f.txt');
    expect(back.ok && back.text).toBe('b b b');
  });

  it('rejects a no-op edit', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'f.txt', content: 'abc' }, ctx);
    const r = await editTool.handler(
      { file_path: 'f.txt', old_string: 'abc', new_string: 'abc' },
      ctx,
    );
    expect(r).toMatch(/exactly the same/);
  });

  it('reports a missing file with a suggestion', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'notes.md', content: 'x' }, ctx);
    const r = await editTool.handler(
      { file_path: 'note.md', old_string: 'x', new_string: 'y' },
      ctx,
    );
    expect(r).toMatch(/does not exist/i);
  });
});

describe('list_files', () => {
  it('lists with status markers and sizes', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('data.csv', Buffer.from('x'));
    await writeTool.handler({ file_path: 'out/summary.md', content: 'yo' }, ctx);
    const r = await listFilesTool.handler({}, ctx);
    expect(r).toContain('[provided]');
    expect(r).toContain('[created]');
    expect(r).toContain('data.csv');
    expect(r).toContain('out/summary.md');
  });

  it('filters by prefix', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'out/a.txt', content: '1' }, ctx);
    await writeTool.handler({ file_path: 'other/b.txt', content: '2' }, ctx);
    const r = await listFilesTool.handler({ path: 'out' }, ctx);
    expect(r).toContain('out/a.txt');
    expect(r).not.toContain('other/b.txt');
  });
});

describe('Glob', () => {
  it('matches by extension across directories', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.csv', content: '1' }, ctx);
    await writeTool.handler({ file_path: 'data/b.csv', content: '2' }, ctx);
    await writeTool.handler({ file_path: 'data/c.txt', content: '3' }, ctx);
    const r = await globTool.handler({ pattern: '**/*.csv' }, ctx);
    expect(r).toBe('a.csv\ndata/b.csv');
  });

  it('scopes matching to a directory', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'data/b.csv', content: '2' }, ctx);
    await writeTool.handler({ file_path: 'other/d.csv', content: '4' }, ctx);
    const r = await globTool.handler({ pattern: '*.csv', path: 'data' }, ctx);
    expect(r).toBe('data/b.csv');
  });

  it('reports no matches', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: '1' }, ctx);
    const r = await globTool.handler({ pattern: '*.md' }, ctx);
    expect(r).toMatch(/No files matching/);
  });
});

describe('Grep', () => {
  it('finds regex matches as path:line: text', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'one\ntwo\nthree two' }, ctx);
    const r = await grepTool.handler({ pattern: 'two' }, ctx);
    expect(r).toContain('a.txt:2: two');
    expect(r).toContain('a.txt:3: three two');
  });

  it('treats the pattern as a regex by default', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'foo123\nbar\nbaz456' }, ctx);
    const r = await grepTool.handler({ pattern: '\\d+' }, ctx);
    expect(r).toContain('a.txt:1: foo123');
    expect(r).toContain('a.txt:3: baz456');
    expect(r).not.toContain('bar');
  });

  it('supports case-insensitive search', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'Hello\nhello\nHELLO' }, ctx);
    const r = await grepTool.handler({ pattern: 'hello', '-i': true }, ctx);
    expect(r).toContain('a.txt:1: Hello');
    expect(r).toContain('a.txt:3: HELLO');
  });

  it('filters by glob', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.ts', content: 'match' }, ctx);
    await writeTool.handler({ file_path: 'b.md', content: 'match' }, ctx);
    const r = await grepTool.handler({ pattern: 'match', glob: '*.ts' }, ctx);
    expect(r).toContain('a.ts:1: match');
    expect(r).not.toContain('b.md');
  });

  it('returns files_with_matches', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'hit\nhit' }, ctx);
    await writeTool.handler({ file_path: 'b.txt', content: 'nope' }, ctx);
    const r = await grepTool.handler({ pattern: 'hit', output_mode: 'files_with_matches' }, ctx);
    expect(r).toBe('a.txt');
  });

  it('returns per-file counts', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'hit\nhit\nmiss' }, ctx);
    const r = await grepTool.handler({ pattern: 'hit', output_mode: 'count' }, ctx);
    expect(r).toBe('a.txt:2');
  });

  it('reports invalid regex cleanly', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'x' }, ctx);
    const r = await grepTool.handler({ pattern: '(' }, ctx);
    expect(r).toMatch(/invalid regular expression/i);
  });

  it('reports no matches', async () => {
    const ctx = makeCtx();
    await writeTool.handler({ file_path: 'a.txt', content: 'x' }, ctx);
    const r = await grepTool.handler({ pattern: 'zzz' }, ctx);
    expect(r).toBe('No matches found.');
  });
});
