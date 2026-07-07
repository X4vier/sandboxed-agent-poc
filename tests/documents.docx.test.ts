import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createExtractorRegistry } from '../src/main/documents';
import { docxExtractor } from '../src/main/documents/extractors/docx';

/**
 * Build a minimal single-entry ZIP (a valid enough .docx skeleton) containing
 * `word/document.xml`, using either stored (method 0) or raw-DEFLATE (method 8)
 * compression. Emits a local file header, a central directory record and an
 * end-of-central-directory record so both parser paths are exercised.
 */
function makeDocx(documentXml: string, compress: boolean, entryName = 'word/document.xml'): Buffer {
  const name = Buffer.from(entryName, 'utf8');
  const uncompressed = Buffer.from(documentXml, 'utf8');
  const data = compress ? deflateRawSync(uncompressed) : uncompressed;
  const method = compress ? 8 : 0;
  const crc = 0; // parser ignores the CRC, so a placeholder is fine here

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18); // compressed size
  localHeader.writeUInt32LE(uncompressed.length, 22); // uncompressed size
  localHeader.writeUInt16LE(name.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra length

  const localRecord = Buffer.concat([localHeader, name, data]);
  const localOffset = 0;

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(uncompressed.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(localOffset, 42);

  const centralRecord = Buffer.concat([central, name]);
  const centralOffset = localRecord.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(1, 8); // entries on disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
function documentXml(...paragraphs: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs.join('')}</w:body></w:document>`
  );
}

describe('docxExtractor', () => {
  it('extracts multi-paragraph text with newlines between paragraphs (stored)', async () => {
    const docx = makeDocx(documentXml(p('First paragraph'), p('Second paragraph')), false);
    const result = await docxExtractor.extract({ name: 'stored.docx', content: docx }, { offset: 1 });
    expect(result.text).toBe('First paragraph\nSecond paragraph');
    expect(result.attachments).toBeUndefined();
  });

  it('inflates DEFLATE-compressed entries', async () => {
    const docx = makeDocx(documentXml(p('Compressed body')), true);
    const result = await docxExtractor.extract({ name: 'zipped.docx', content: docx }, { offset: 1 });
    expect(result.text).toBe('Compressed body');
  });

  it('decodes XML entities', async () => {
    const docx = makeDocx(documentXml(p('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;')), false);
    const result = await docxExtractor.extract({ name: 'entities.docx', content: docx }, { offset: 1 });
    expect(result.text).toBe('a & b <c> "d" \'e\' AB');
  });

  it('maps tabs and breaks within a run', async () => {
    const xml = documentXml('<w:p><w:r><w:t>col1</w:t><w:tab/><w:t>col2</w:t><w:br/><w:t>line2</w:t></w:r></w:p>');
    const docx = makeDocx(xml, true);
    const result = await docxExtractor.extract({ name: 'tabs.docx', content: docx }, { offset: 1 });
    expect(result.text).toBe('col1\tcol2\nline2');
  });

  it('returns a diagnostic when word/document.xml is missing', async () => {
    // A ZIP whose only entry is some other file — no document.xml to read.
    const missing = makeDocx('<not-a-document/>', false, 'word/otherfile.xml');
    const result = await docxExtractor.extract({ name: 'empty.docx', content: missing }, { offset: 1 });
    expect(result.text).toBe('Could not extract text from "empty.docx".');
  });

  it('windows long text by line and points to the offset to resume from', async () => {
    const paragraphs = Array.from({ length: 500 }, (_, i) => p(`Paragraph ${i + 1}`));
    const docx = makeDocx(documentXml(...paragraphs), true);

    const first = await docxExtractor.extract({ name: 'long.docx', content: docx }, { offset: 1, limit: 100 });
    expect(first.text).toMatch(/(^|\n)Paragraph 100(\n|$)/);
    expect(first.text).not.toMatch(/(^|\n)Paragraph 101(\n|$)/);
    expect(first.text).toMatch(/re-call with offset=101 to continue/);

    const second = await docxExtractor.extract({ name: 'long.docx', content: docx }, { offset: 101, limit: 100 });
    expect(second.text).toMatch(/(^|\n)Paragraph 101(\n|$)/);
    expect(second.text).not.toMatch(/(^|\n)Paragraph 100(\n|$)/);
  });

  it('caps a single oversized line by characters', async () => {
    const docx = makeDocx(documentXml(p('x'.repeat(5000))), true);
    const result = await docxExtractor.extract({ name: 'wide.docx', content: docx }, { offset: 1 });
    expect(result.text).toContain('line truncated');
    expect(result.text.length).toBeLessThan(5000);
  });
});

describe('extractor registry (docx)', () => {
  it('resolves docx and lists it as supported', async () => {
    const registry = createExtractorRegistry();
    expect(registry.get('docx')).toBe(docxExtractor);
    expect(registry.get('DOCX')).toBe(docxExtractor); // case-insensitive
    expect(registry.supportedExtensions()).toContain('docx');
  });
});
