import { describe, it, expect } from 'vitest';
import { listFilesTool } from '../src/main/tools/listFiles';
import { writeTool } from '../src/main/tools/write';
import { makeCtx } from './toolCtx';

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
