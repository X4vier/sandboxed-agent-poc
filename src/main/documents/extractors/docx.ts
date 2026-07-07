import { inflateRawSync } from 'node:zlib';
import type { Extraction, Extractor, SourceFile } from '../types';

/**
 * Word (.docx) text extraction, no third-party dependencies.
 *
 * A .docx is a ZIP archive whose main body lives in the `word/document.xml`
 * entry. Strategy:
 *   1. parse the ZIP ourselves to locate and decompress `word/document.xml`;
 *   2. flatten its WordprocessingML into readable text — paragraphs become
 *      newlines, `<w:t>` runs supply the visible characters, tabs/breaks map to
 *      `\t` / `\n`, and every other tag is stripped;
 *   3. decode the XML entities left behind.
 *
 * ZIP entries are either stored (method 0, raw bytes) or DEFLATE-compressed
 * (method 8, inflated with {@link inflateRawSync}). We read the entry from its
 * local file header; when a header omits the size (streaming mode, bit 3 of the
 * general-purpose flag), we fall back to the central directory, which always
 * carries the sizes. When `word/document.xml` can't be located or decompressed
 * we return a short diagnostic instead of throwing — this is a pure extractor.
 */

const LOCAL_FILE_HEADER = 0x04034b50; // 'PK\x03\x04'
const CENTRAL_DIR_HEADER = 0x02014b50; // 'PK\x01\x02'
const DOCUMENT_PATH = 'word/document.xml';

export const docxExtractor: Extractor = {
  extensions: ['docx'],
  label: 'Word document',
  extract(file: SourceFile): Extraction {
    const xml = readDocumentXml(file.content);
    if (xml === null) {
      return { text: `Could not extract text from "${file.name}".` };
    }
    return { text: xmlToText(xml) };
  },
};

/** Locate and decompress `word/document.xml`, or return null if unavailable. */
function readDocumentXml(zip: Buffer): string | null {
  const entry = findEntry(zip, DOCUMENT_PATH);
  if (entry === null) return null;
  try {
    const bytes = entry.method === 8 ? inflateRawSync(entry.data) : entry.data;
    return bytes.toString('utf8');
  } catch {
    return null; // corrupt / unexpected compression
  }
}

interface ZipEntry {
  method: number;
  data: Buffer;
}

/**
 * Find a named entry by walking local file headers. Falls back to the central
 * directory when a local header stores a zero compressed size (data-descriptor
 * / streaming mode).
 */
function findEntry(zip: Buffer, name: string): ZipEntry | null {
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === LOCAL_FILE_HEADER) {
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const entryName = zip.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;

    // Bit 3 set (or a zero size on a non-empty entry) means the sizes live in a
    // trailing data descriptor — defer to the central directory for those.
    const streaming = (flags & 0x08) !== 0 || compressedSize === 0;
    if (entryName === name && !streaming) {
      return { method, data: zip.subarray(dataStart, dataStart + compressedSize) };
    }
    if (entryName === name && streaming) {
      return findEntryViaCentralDirectory(zip, name);
    }
    if (streaming) break; // can't compute the next header without the size

    offset = dataStart + compressedSize;
  }
  return findEntryViaCentralDirectory(zip, name);
}

/** Resolve an entry through the central directory, which always has sizes. */
function findEntryViaCentralDirectory(zip: Buffer, name: string): ZipEntry | null {
  let offset = 0;
  while (offset + 46 <= zip.length) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIR_HEADER) {
      offset++;
      continue;
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (entryName === name) {
      // Read the data at the local header, whose own name/extra lengths tell us
      // where the payload begins.
      const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      return { method, data: zip.subarray(dataStart, dataStart + compressedSize) };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * Flatten WordprocessingML to plain text. Closing `</w:p>` becomes a newline,
 * `<w:tab/>` a tab, `<w:br/>`/`<w:cr/>` a newline; every remaining tag is
 * stripped, leaving only the text content of `<w:t>` runs (the only place
 * visible characters live) in document order. Entities are decoded last.
 */
function xmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:cr\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n');

  // Strip every element tag. Text nodes (i.e. `<w:t>` content) survive, and the
  // structural markers injected above are plain characters, so order is kept.
  const stripped = withBreaks.replace(/<[^>]*>/g, '');

  return decodeEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode the five predefined XML entities plus numeric character references. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function codePoint(value: number): string {
  return Number.isFinite(value) ? String.fromCodePoint(value) : '';
}
