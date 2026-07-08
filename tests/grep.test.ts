import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MAX_INDEX_TEXT_BYTES } from '../src/main/documents/textIndex';
import { grepTool } from '../src/main/tools/grep';
import { writeTool } from '../src/main/tools/write';
import { makeCtx } from './toolCtx';

function makeDocx(documentXml: string, compress = true): Buffer {
  const name = Buffer.from('word/document.xml', 'utf8');
  const uncompressed = Buffer.from(documentXml, 'utf8');
  const data = compress ? deflateRawSync(uncompressed) : uncompressed;
  const method = compress ? 8 : 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(uncompressed.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const localRecord = Buffer.concat([localHeader, name, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(uncompressed.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralRecord = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const p = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

function documentXml(...paragraphs: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs.join('')}</w:body></w:document>`
  );
}

async function makePdfWithText(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 250, font, size: 12 });
  }
  return Buffer.from(await doc.save());
}

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

  it('searches extracted PDF text and reports page numbers', async () => {
    const ctx = makeCtx();
    ctx.vfs.writeFile(
      'reports/q3.pdf',
      await makePdfWithText(['ordinary first page', 'needle appears on second page']),
    );

    const r = await grepTool.handler({ pattern: 'needle' }, ctx);
    expect(r).toContain('reports/q3.pdf (page 2): needle appears on second page');
    expect(r).not.toContain('page 1');
  });

  it('treats corrupt PDFs as having no searchable matches', async () => {
    const ctx = makeCtx();
    ctx.vfs.writeFile('broken.pdf', Buffer.from('not a real pdf with needle text'));

    const r = await grepTool.handler({ pattern: 'needle', glob: '*.pdf' }, ctx);
    expect(r).toBe('No matches found.');
  });

  it('searches extracted DOCX text', async () => {
    const ctx = makeCtx();
    ctx.vfs.writeFile('notes/brief.docx', makeDocx(documentXml(p('First paragraph'), p('DOCX needle here'))));

    const r = await grepTool.handler({ pattern: 'DOCX needle' }, ctx);
    expect(r).toContain('notes/brief.docx: DOCX needle here');
  });

  it('invalidates extracted-text cache when a document is overwritten', async () => {
    const ctx = makeCtx();
    ctx.vfs.stageProvided('brief.docx', makeDocx(documentXml(p('old needle'))));

    expect(await grepTool.handler({ pattern: 'old needle' }, ctx)).toContain('brief.docx');
    ctx.vfs.writeFile('brief.docx', makeDocx(documentXml(p('new needle'))));

    expect(await grepTool.handler({ pattern: 'old needle' }, ctx)).toBe('No matches found.');
    expect(await grepTool.handler({ pattern: 'new needle' }, ctx)).toContain('brief.docx: new needle');
  });

  it('caps matches and truncates long match lines', async () => {
    const ctx = makeCtx();
    const long = `hit ${'x'.repeat(700)}`;
    await writeTool.handler({
      file_path: 'many.txt',
      content: Array.from({ length: 105 }, () => long).join('\n'),
    }, ctx);

    const r = await grepTool.handler({ pattern: 'hit' }, ctx);
    expect(r.split('\n').filter((line) => line.startsWith('many.txt:'))).toHaveLength(100);
    expect(r).toContain('[line truncated]');
    expect(r).toContain('[... 5 more matches — refine your pattern or add an include filter]');
    expect(r).not.toContain('x'.repeat(550));
  });

  it('skips documents whose extracted text exceeds the Grep index cap', async () => {
    const ctx = makeCtx();
    const huge = `needle ${'x'.repeat(MAX_INDEX_TEXT_BYTES + 1)}`;
    ctx.vfs.stageProvided('huge.docx', makeDocx(documentXml(p(huge)), false));

    const r = await grepTool.handler({ pattern: 'needle', glob: '*.docx' }, ctx);
    expect(r).toContain('No matches found.');
    expect(r).toContain('skipped huge.docx');
    expect(r).toContain('Grep index cap');
  });
});
