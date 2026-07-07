import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';
import type { Attachment } from '../src/main/documents';
import { createExtractorRegistry } from '../src/main/documents';
import { pdfExtractor } from '../src/main/documents/extractors/pdf';
import { createReadDocumentTool } from '../src/main/tools/documentTools';

/** A real, loadable PDF with `pages` blank pages. */
async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

/** Count the pages of a base64 PDF that was attached to the conversation. */
async function pagesOf(attachment: Attachment): Promise<number> {
  const doc = await PDFDocument.load(Buffer.from(attachment.data, 'base64'));
  return doc.getPageCount();
}

describe('pdfExtractor', () => {
  it('attaches a bounded page window and reports the resume offset', async () => {
    const pdf = await makePdf(25);
    const result = await pdfExtractor.extract({ name: 'big.pdf', content: pdf }, { offset: 1 });

    expect(result.text).toMatch(/pages 1-10 of 25/);
    expect(result.text).toMatch(/offset=11/);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]).toMatchObject({ kind: 'document', mediaType: 'application/pdf' });
    expect(await pagesOf(result.attachments![0])).toBe(10);
  });

  it('reads a later page range from the given offset', async () => {
    const pdf = await makePdf(25);
    const result = await pdfExtractor.extract({ name: 'big.pdf', content: pdf }, { offset: 11 });
    expect(result.text).toMatch(/pages 11-20 of 25/);
    expect(result.text).toMatch(/offset=21/);
    expect(await pagesOf(result.attachments![0])).toBe(10);
  });

  it('reports when a page offset is past the end instead of clamping', async () => {
    const pdf = await makePdf(3);
    const result = await pdfExtractor.extract({ name: 'short.pdf', content: pdf }, { offset: 4 });
    expect(result.text).toBe('offset 4 is past the end of "short.pdf", which has 3 page(s).');
    expect(result.attachments).toBeUndefined();
  });

  it('caps a single call at the maximum page count', async () => {
    const pdf = await makePdf(50);
    const result = await pdfExtractor.extract({ name: 'big.pdf', content: pdf }, { offset: 1, limit: 999 });
    expect(result.text).toMatch(/pages 1-20 of 50/);
    expect(await pagesOf(result.attachments![0])).toBe(20);
  });

  it('attaches the whole thing with no resume note when it fits', async () => {
    const pdf = await makePdf(1);
    const result = await pdfExtractor.extract({ name: 'small.pdf', content: pdf }, { offset: 1 });
    expect(result.text).toMatch(/the only page/);
    expect(result.text).not.toMatch(/offset=/);
    expect(await pagesOf(result.attachments![0])).toBe(1);
  });

  it('returns a diagnostic instead of throwing on a non-PDF buffer', async () => {
    const result = await pdfExtractor.extract(
      { name: 'bogus.pdf', content: Buffer.from('this is not a pdf') },
      { offset: 1 },
    );
    expect(result.text).toMatch(/could not open/i);
    expect(result.attachments).toBeUndefined();
  });

  it('reads a real PDF fixture as a bounded attachment', async () => {
    const pdf = readFileSync('tests/fixtures/pdf/tropical-escape-itinerary.pdf');
    const result = await pdfExtractor.extract(
      { name: 'tropical-escape-itinerary.pdf', content: pdf },
      { offset: 1 },
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]).toMatchObject({ kind: 'document', mediaType: 'application/pdf' });
    expect(await pagesOf(result.attachments![0])).toBeGreaterThan(0);
  });
});

describe('extractor registry', () => {
  it('resolves pdf and reports supported extensions', () => {
    const registry = createExtractorRegistry();
    expect(registry.get('pdf')).toBe(pdfExtractor);
    expect(registry.get('PDF')).toBe(pdfExtractor); // case-insensitive
    expect(registry.get('xlsx')).toBeUndefined();
    expect(registry.supportedExtensions()).toContain('pdf');
  });
});

describe('read_document tool', () => {
  function makeCtx(vfs: VirtualWorkspace, attached: ContentBlockParam[]): ToolContext {
    return {
      vfs,
      normalizePath: normalizeWorkspacePath,
      emit: () => {},
      signal: new AbortController().signal,
      attachBlocks: (blocks) => attached.push(...blocks),
      depth: 0,
      runSubagent: async () => '',
    };
  }

  it('attaches PDF pages and surfaces the extractor note', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('report.pdf', await makePdf(3));
    const attached: ContentBlockParam[] = [];
    const tool = createReadDocumentTool(createExtractorRegistry());
    const out = await tool.handler({ path: 'report.pdf' }, makeCtx(vfs, attached));
    expect(out).toMatch(/pages 1-3 of 3|the only page/);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ type: 'document', source: { type: 'base64' } });
  });

  it('passes offset/limit through as a page window', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('report.pdf', await makePdf(30));
    const attached: ContentBlockParam[] = [];
    const tool = createReadDocumentTool(createExtractorRegistry());
    const out = await tool.handler({ path: 'report.pdf', offset: 5, limit: 3 }, makeCtx(vfs, attached));
    expect(out).toMatch(/pages 5-7 of 30/);
    expect(attached).toHaveLength(1);
  });

  it('reports unsupported extensions instead of throwing', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('notes.xlsx', Buffer.from('PK\x03\x04'));
    const tool = createReadDocumentTool(createExtractorRegistry());
    const out = await tool.handler({ path: 'notes.xlsx' }, makeCtx(vfs, []));
    expect(out).toMatch(/no reader for "\.xlsx"/i);
  });
});
