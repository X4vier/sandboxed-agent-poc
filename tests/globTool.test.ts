import { describe, it, expect } from 'vitest';
import { globTool } from '../src/main/tools/globTool';
import { writeTool } from '../src/main/tools/write';
import { makeCtx } from './toolCtx';

describe('Glob tool', () => {
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
