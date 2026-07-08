import { describe, it, expect } from 'vitest';
import { editTool } from '../src/main/tools/edit';
import { writeTool } from '../src/main/tools/write';
import { makeCtx } from './toolCtx';

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
