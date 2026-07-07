import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';
import { createExtractorRegistry } from '../src/main/documents';
import { pdfExtractor } from '../src/main/documents/extractors/pdf';
import { createReadDocumentTool } from '../src/main/tools/documentTools';

/** Wrap a content stream body in a minimal PDF shell the extractor can scan. */
function pdfWith(body: Buffer, dict = ''): Buffer {
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj << ${dict}/Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream endobj\n', 'latin1'),
  ]);
}

function streamObject(objectNumber: number, body: Buffer, dict = ''): Buffer {
  return Buffer.concat([
    Buffer.from(`${objectNumber} 0 obj\n<< ${dict}/Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

describe('pdfExtractor', () => {
  it('extracts text from an uncompressed content stream', async () => {
    const pdf = pdfWith(Buffer.from('BT /F1 12 Tf 72 720 Td (Hello, world!) Tj ET', 'latin1'));
    const result = await pdfExtractor.extract({ name: 'doc.pdf', content: pdf });
    expect(result.text).toBe('Hello, world!');
    expect(result.attachments).toBeUndefined();
  });

  it('inflates FlateDecode streams before extracting', async () => {
    const body = deflateSync(Buffer.from('BT (Compressed text here) Tj ET', 'latin1'));
    const pdf = pdfWith(body, '/Filter /FlateDecode ');
    const result = await pdfExtractor.extract({ name: 'z.pdf', content: pdf });
    expect(result.text).toBe('Compressed text here');
  });

  it('preserves line breaks across positioning operators', async () => {
    const pdf = pdfWith(
      Buffer.from('BT 72 720 Td (Line one) Tj 0 -14 Td (Line two) Tj ET', 'latin1'),
    );
    const result = await pdfExtractor.extract({ name: 'multi.pdf', content: pdf });
    expect(result.text).toBe('Line one\nLine two');
  });

  it('decodes escape sequences in literal strings', async () => {
    const pdf = pdfWith(Buffer.from('BT (a\\(b\\) c) Tj ET', 'latin1'));
    const result = await pdfExtractor.extract({ name: 'esc.pdf', content: pdf });
    expect(result.text).toBe('a(b) c');
  });

  it('decodes ordinary hex strings as bytes when no font map is present', async () => {
    const pdf = pdfWith(Buffer.from('BT <4865> Tj ET', 'latin1'));
    const result = await pdfExtractor.extract({ name: 'hex.pdf', content: pdf });
    expect(result.text).toBe('He');
  });

  it('ignores invalid ToUnicode ranges instead of throwing', async () => {
    const cmap = Buffer.from(
      'begincmap\nbeginbfrange\n<0001> <0001> <d8000000>\nendbfrange\nendcmap',
      'latin1',
    );
    const pdf = Buffer.concat([
      pdfWith(cmap),
      pdfWith(Buffer.from('BT (Hello after cmap) Tj ET', 'latin1')),
    ]);

    const result = await pdfExtractor.extract({ name: 'bad-cmap.pdf', content: pdf });

    expect(result.text).toBe('Hello after cmap');
  });

  it('keeps ToUnicode streams attached to their own object number', async () => {
    const cmap = Buffer.from(
      [
        'begincmap',
        'beginbfchar',
        '<0001> <0041>',
        'endbfchar',
        'endcmap',
      ].join('\n'),
      'latin1',
    );
    const body = Buffer.from('BT /F1 12 Tf <0001> Tj ET', 'latin1');
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('1 0 obj\n<</Type /FontDescriptor>>\nendobj\n', 'latin1'),
      Buffer.from(
        '2 0 obj\n<</Type /Font /Subtype /Type0 /ToUnicode 3 0 R>>\nendobj\n',
        'latin1',
      ),
      streamObject(3, cmap),
      Buffer.from('4 0 obj\n<</Font <</F1 2 0 R>>>>\nendobj\n', 'latin1'),
      streamObject(5, body),
    ]);

    const result = await pdfExtractor.extract({ name: 'mapped.pdf', content: pdf });

    expect(result.text).toBe('A');
  });

  it('extracts readable text from a real PDF fixture with embedded font maps', async () => {
    const pdf = readFileSync('tests/fixtures/pdf/tropical-escape-itinerary.pdf');
    const result = await pdfExtractor.extract({ name: 'tropical-escape-itinerary.pdf', content: pdf });

    expect(result.attachments).toBeUndefined();
    expect(result.text).not.toContain('\u0000');
    expect(result.text).toContain('TROPICAL ESCAPE');
    expect(result.text).toContain('Part 1: Cairns & The Ancient Daintree');
    expect(result.text).toContain('Arrival & Beef Burgers');
    expect(result.text).toContain('Mossman Gorge');
    expect(result.text).toContain('Travel Notes & Tips');
  });

  it('falls back to a native PDF attachment when there is no text layer', async () => {
    // An image-only stream carries no BT operator, so no text is recovered.
    const pdf = pdfWith(Buffer.from([0x00, 0x01, 0x02]), '/Subtype /Image ');
    const result = await pdfExtractor.extract({ name: 'scan.pdf', content: pdf });
    expect(result.text).toMatch(/no extractable text/i);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments?.[0]).toMatchObject({ kind: 'document', mediaType: 'application/pdf' });
    expect(result.attachments?.[0]?.data).toBe(pdf.toString('base64'));
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

  it('returns extracted text for a parseable PDF', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('report.pdf', pdfWith(Buffer.from('BT (Quarterly results) Tj ET', 'latin1')));
    const attached: ContentBlockParam[] = [];
    const tool = createReadDocumentTool(createExtractorRegistry());
    const out = await tool.handler({ path: 'report.pdf' }, makeCtx(vfs, attached));
    expect(out).toBe('Quarterly results');
    expect(attached).toHaveLength(0);
  });

  it('attaches a content block for an image-only PDF', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('scan.pdf', pdfWith(Buffer.from([0x00, 0x01]), '/Subtype /Image '));
    const attached: ContentBlockParam[] = [];
    const tool = createReadDocumentTool(createExtractorRegistry());
    await tool.handler({ path: 'scan.pdf' }, makeCtx(vfs, attached));
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ type: 'document', source: { type: 'base64' } });
  });

  it('reports unsupported extensions instead of throwing', async () => {
    const vfs = new VirtualWorkspace();
    vfs.stageProvided('notes.xlsx', Buffer.from('PK\x03\x04'));
    const tool = createReadDocumentTool(createExtractorRegistry());
    const out = await tool.handler({ path: 'notes.xlsx' }, makeCtx(vfs, []));
    expect(out).toMatch(/no reader for "\.xlsx"/i);
  });
});
