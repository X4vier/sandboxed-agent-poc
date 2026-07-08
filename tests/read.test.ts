import { describe, it, expect } from 'vitest';
import { readTool } from '../src/main/tools/read';
import { writeTool } from '../src/main/tools/write';
import { makeCtx } from './toolCtx';

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

  it('caps output at 50KB and tells the model where to resume', async () => {
    const ctx = makeCtx();
    // 4000 lines of ~50 bytes each ≈ 200KB — well past the 50KB byte cap, but
    // under the 2000-line cap only after the byte cap already bit.
    const lines = Array.from({ length: 4000 }, (_, i) => `${'y'.repeat(48)} ${i}`).join('\n');
    ctx.vfs.stageProvided('huge.txt', Buffer.from(lines, 'utf-8'));
    const r = await readTool.handler({ file_path: 'huge.txt', limit: 5000 }, ctx);
    expect(r).toMatch(/hit the 50\.0KB byte cap/);
    expect(r).toMatch(/re-call with offset=\d+ to continue/);
    // Roughly the byte cap, not the whole 200KB file.
    expect(Buffer.byteLength(r, 'utf-8')).toBeLessThan(60 * 1024);
  });

  it('caps absurdly long single lines', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('min.js', Buffer.from('x'.repeat(5000), 'utf-8'));
    const r = await readTool.handler({ file_path: 'min.js' }, ctx);
    expect(r).toMatch(/line truncated/);
    expect(r.length).toBeLessThan(5000);
  });

  it('reports a single line that exceeds the byte cap rather than showing it', async () => {
    const ctx = makeCtx();
    // One line of 60KB — over the 50KB per-read byte cap.
    ctx.vfs.stageProvided('one.min.js', Buffer.from('z'.repeat(60 * 1024), 'utf-8'));
    const r = await readTool.handler({ file_path: 'one.min.js' }, ctx);
    expect(r).toMatch(/Line 1 of "one\.min\.js" is 60\.0KB/);
    expect(r).toMatch(/larger than the 50\.0KB per-read limit/);
    expect(r).toMatch(/Use Grep/);
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
