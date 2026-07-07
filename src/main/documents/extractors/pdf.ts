import { inflateSync, inflateRawSync } from 'node:zlib';
import type { Extraction, Extractor, SourceFile } from '../types';

/**
 * Naive PDF text extraction, no third-party dependencies.
 *
 * Strategy:
 *   1. locate the file's `stream … endstream` regions;
 *   2. inflate FlateDecode compression (the common case) via Node's zlib;
 *   3. read simple embedded ToUnicode CMaps and resolve page font resources;
 *   4. pull operands out of the text-showing operators (Tj, TJ, ', ").
 *
 * This is good enough for most digitally-generated PDFs. It deliberately does
 * NOT handle:
 *   - content streams packed inside object streams (/ObjStm);
 *   - scanned / image-only PDFs, which carry no text operators at all.
 *
 * When no text can be recovered we fall back to attaching the PDF natively so a
 * vision-capable model can still read it.
 */

// base64 inflates ~33%; keep native attachments under the ~32MB API request cap.
const MAX_NATIVE_BYTES = 24 * 1024 * 1024;

export const pdfExtractor: Extractor = {
  extensions: ['pdf'],
  label: 'PDF',
  extract(file: SourceFile): Extraction {
    const text = extractPdfText(file.content).trim();
    if (text.length > 0) return { text };

    if (file.content.length <= MAX_NATIVE_BYTES) {
      return {
        text: `No extractable text layer in "${file.name}". Attaching the PDF for visual reading.`,
        attachments: [
          { kind: 'document', mediaType: 'application/pdf', data: file.content.toString('base64') },
        ],
      };
    }
    return {
      text: `No extractable text layer in "${file.name}", and it is too large to attach natively.`,
    };
  },
};

function extractPdfText(pdf: Buffer): string {
  const pieces: string[] = [];
  const fontMaps = readFontUnicodeMaps(pdf);
  for (const stream of pdfStreams(pdf)) {
    const decoded = inflate(stream.data) ?? stream.data;
    const text = decoded.toString('latin1');
    if (!text.includes('BT')) continue; // skip font/image/metadata streams
    const extracted = extractTextOperators(text, fontMaps);
    if (extracted.trim()) pieces.push(extracted);
  }
  return pieces.join('\n').replace(/\n{3,}/g, '\n\n');
}

interface PdfStream {
  objectNumber: number | null;
  dict: string;
  data: Buffer;
}

/** Yield the raw bytes of each `stream … endstream` region. */
function* pdfStreams(pdf: Buffer): Generator<PdfStream> {
  const s = pdf.toString('latin1');
  // Match normal indirect stream objects. This parser is deliberately small,
  // but generated PDFs usually keep stream dictionaries in this straightforward
  // shape. Do not cross an endobj looking for a later stream; otherwise a
  // non-stream object immediately before a stream object can steal its stream
  // and object number, which breaks ToUnicode font-map references.
  const re =
    /(?:^|\r?\n)(\d+)\s+\d+\s+obj\s*<<((?:(?!\bendobj\b)[\s\S])*?)>>\s*stream(?:\r\n|\r|\n)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    const dataStart = match.index + match[0].length;
    const end = s.indexOf('endstream', dataStart);
    if (end === -1) break;
    // Trim the single EOL that precedes `endstream`.
    let dataEnd = end;
    if (s[dataEnd - 1] === '\n') dataEnd--;
    if (s[dataEnd - 1] === '\r') dataEnd--;
    yield {
      objectNumber: Number(match[1]),
      dict: match[2],
      data: pdf.subarray(dataStart, dataEnd),
    };
    re.lastIndex = end + 'endstream'.length;
  }
}

function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data);
  } catch {
    /* not zlib-wrapped */
  }
  try {
    return inflateRawSync(data);
  } catch {
    /* not raw deflate either — likely already uncompressed */
  }
  return null;
}

/**
 * Walk a decoded content stream, collecting the strings shown by text
 * operators. Positioning operators (Td/TD/T*) and the show-and-move operators
 * (' and ") emit a newline, which approximates line breaks well enough for
 * reading.
 */
function extractTextOperators(content: string, fontMaps: Map<string, FontUnicodeMap>): string {
  let out = '';
  let i = 0;
  let currentFont: string | null = null;
  let pendingResourceName: string | null = null;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '(') {
      const parsed = readLiteralString(content, i);
      const fontMap = currentFont === null ? undefined : fontMaps.get(currentFont);
      out += fontMap === undefined ? parsed.value : decodeMappedText(parsed.value, fontMap);
      i = parsed.next;
    } else if (ch === '/') {
      const parsed = readName(content, i);
      pendingResourceName = parsed.value;
      i = parsed.next;
    } else if (ch === '<' && content[i + 1] === '<') {
      i += 2; // inline dictionary opener — skip
    } else if (ch === '<') {
      const fontMap = currentFont === null ? undefined : fontMaps.get(currentFont);
      const parsed = readHexString(content, i, fontMap);
      out += parsed.value;
      i = parsed.next;
    } else if (isOperatorStart(ch)) {
      let op = '';
      let j = i;
      while (j < n && isOperatorChar(content[j])) {
        op += content[j];
        j++;
      }
      if (op === 'Tf' && pendingResourceName !== null) {
        currentFont = pendingResourceName;
      }
      if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET' || op === "'" || op === '"') {
        out += '\n';
      }
      i = j > i ? j : i + 1;
    } else {
      i++;
    }
  }
  return out;
}

function isOperatorStart(ch: string): boolean {
  return /[A-Za-z'"]/.test(ch);
}

function isOperatorChar(ch: string): boolean {
  return /[A-Za-z0-9*'"]/.test(ch);
}

function readName(content: string, start: number): { value: string; next: number } {
  let i = start + 1;
  while (i < content.length && !/[\s[\]<>(){}\/%]/.test(content[i])) i++;
  return { value: content.slice(start + 1, i), next: i };
}

/** Parse a `( … )` literal string starting at `start` (the opening paren). */
function readLiteralString(content: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let depth = 0;
  let value = '';
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '\\') {
      const esc = content[i + 1];
      switch (esc) {
        case 'n': value += '\n'; i += 2; break;
        case 'r': value += '\r'; i += 2; break;
        case 't': value += '\t'; i += 2; break;
        case 'b': value += '\b'; i += 2; break;
        case 'f': value += '\f'; i += 2; break;
        case '(': value += '('; i += 2; break;
        case ')': value += ')'; i += 2; break;
        case '\\': value += '\\'; i += 2; break;
        default:
          if (esc >= '0' && esc <= '7') {
            let oct = '';
            let j = i + 1;
            while (j < n && oct.length < 3 && content[j] >= '0' && content[j] <= '7') {
              oct += content[j];
              j++;
            }
            value += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i = j;
          } else if (esc === '\n' || esc === '\r') {
            i += 2; // backslash-newline: line continuation, emit nothing
          } else {
            value += esc ?? '';
            i += 2;
          }
      }
    } else if (ch === '(') {
      depth++;
      value += ch;
      i++;
    } else if (ch === ')') {
      if (depth === 0) {
        i++;
        break;
      }
      depth--;
      value += ch;
      i++;
    } else {
      value += ch;
      i++;
    }
  }
  return { value, next: i };
}

/** Parse a `< … >` hex string starting at `start` (the opening angle). */
function readHexString(content: string, start: number, fontMap?: FontUnicodeMap): { value: string; next: number } {
  let i = start + 1;
  let hex = '';
  const n = content.length;
  while (i < n && content[i] !== '>') {
    if (/[0-9A-Fa-f]/.test(content[i])) hex += content[i];
    i++;
  }
  if (i < n) i++; // consume '>'
  const value = fontMap === undefined ? decodeByteHex(hex) : decodeMappedHex(hex, fontMap);
  return { value, next: i };
}

interface PdfObject {
  objectNumber: number;
  body: string;
}

interface FontUnicodeMap {
  entries: Map<string, string>;
  codeLengths: number[];
}

function readFontUnicodeMaps(pdf: Buffer): Map<string, FontUnicodeMap> {
  const streams = [...pdfStreams(pdf)];
  const unicodeByObject = new Map<number, FontUnicodeMap>();

  for (const stream of streams) {
    const decoded = inflate(stream.data) ?? stream.data;
    const text = decoded.toString('latin1');
    if (stream.objectNumber !== null && text.includes('begincmap')) {
      unicodeByObject.set(stream.objectNumber, parseCMap(text));
    }
  }

  const fontObjectToUnicode = new Map<number, FontUnicodeMap>();
  for (const object of readPdfObjects(pdf, streams)) {
    const match = object.body.match(/\/Type\s*\/Font\b[\s\S]*?\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (match === null) continue;
    const unicode = unicodeByObject.get(Number(match[1]));
    if (unicode !== undefined) fontObjectToUnicode.set(object.objectNumber, unicode);
  }

  const fontMaps = new Map<string, FontUnicodeMap>();
  for (const object of readPdfObjects(pdf, streams)) {
    const refRe = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g;
    let match: RegExpExecArray | null;
    while ((match = refRe.exec(object.body)) !== null) {
      const unicode = fontObjectToUnicode.get(Number(match[2]));
      if (unicode !== undefined) fontMaps.set(match[1], unicode);
    }
  }
  return fontMaps;
}

function readPdfObjects(pdf: Buffer, streams: PdfStream[]): PdfObject[] {
  const objects: PdfObject[] = [];
  const s = pdf.toString('latin1');
  const objectRe = /(\d+)\s+\d+\s+obj\s*([\s\S]*?)\s*endobj/g;
  let match: RegExpExecArray | null;
  while ((match = objectRe.exec(s)) !== null) {
    objects.push({ objectNumber: Number(match[1]), body: match[2] });
  }

  for (const stream of streams) {
    if (!/\/Type\s*\/ObjStm\b/.test(stream.dict)) continue;
    objects.push(...readObjectStreamObjects(stream));
  }
  return objects;
}

function readObjectStreamObjects(stream: PdfStream): PdfObject[] {
  const firstMatch = stream.dict.match(/\/First\s+(\d+)/);
  const countMatch = stream.dict.match(/\/N\s+(\d+)/);
  if (firstMatch === null || countMatch === null) return [];

  const decoded = inflate(stream.data) ?? stream.data;
  const text = decoded.toString('latin1');
  const first = Number(firstMatch[1]);
  const count = Number(countMatch[1]);
  const numbers = [...text.slice(0, first).matchAll(/\d+/g)].map((match) => Number(match[0]));
  const objects: PdfObject[] = [];

  for (let i = 0; i < count && i * 2 + 1 < numbers.length; i++) {
    const objectNumber = numbers[i * 2];
    const objectStart = first + numbers[i * 2 + 1];
    const nextOffset = i + 1 < count ? numbers[(i + 1) * 2 + 1] : text.length - first;
    const objectEnd = first + nextOffset;
    objects.push({ objectNumber, body: text.slice(objectStart, objectEnd).trim() });
  }
  return objects;
}

function parseCMap(cmap: string): FontUnicodeMap {
  const entries = new Map<string, string>();

  for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const charRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g;
    let match: RegExpExecArray | null;
    while ((match = charRe.exec(section[1])) !== null) {
      entries.set(normalizeHex(match[1]), decodeUnicodeHex(match[2]));
    }
  }

  for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    readCMapRanges(section[1], entries);
  }

  const codeLengths = [...new Set([...entries.keys()].map((key) => key.length))].sort((a, b) => b - a);
  return { entries, codeLengths };
}

function readCMapRanges(section: string, entries: Map<string, string>): void {
  const arrayRangeRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+\[([\s\S]*?)\]/g;
  let arrayMatch: RegExpExecArray | null;
  while ((arrayMatch = arrayRangeRe.exec(section)) !== null) {
    const start = parseInt(arrayMatch[1], 16);
    const end = parseInt(arrayMatch[2], 16);
    const sourceLength = normalizeHex(arrayMatch[1]).length;
    const values = [...arrayMatch[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((match) => match[1]);
    for (let offset = 0; offset <= end - start && offset < values.length; offset++) {
      entries.set((start + offset).toString(16).padStart(sourceLength, '0'), decodeUnicodeHex(values[offset]));
    }
  }

  const sequentialRangeRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = sequentialRangeRe.exec(section)) !== null) {
    const start = parseInt(rangeMatch[1], 16);
    const end = parseInt(rangeMatch[2], 16);
    const sourceLength = normalizeHex(rangeMatch[1]).length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) continue;
    const rangeSize = end - start + 1;
    if (rangeSize > 0x10000) continue;
    for (let offset = 0; offset < rangeSize; offset++) {
      const destination = offsetUnicodeHex(rangeMatch[3], offset);
      if (destination === null) continue;
      entries.set(
        (start + offset).toString(16).padStart(sourceLength, '0'),
        destination,
      );
    }
  }
}

function offsetUnicodeHex(hex: string, offset: number): string | null {
  const clean = normalizeHex(hex);
  if (clean.length < 4 || clean.length % 4 !== 0) return null;

  const units: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const unit = parseInt(clean.slice(i, i + 4), 16);
    if (!Number.isFinite(unit)) return null;
    units.push(unit);
  }

  const last = units.length - 1;
  units[last] += offset;
  if (units[last] > 0xffff) return null;
  return decodeUtf16Units(units);
}

function decodeUtf16Units(units: number[]): string | null {
  let value = '';
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = units[i + 1];
      if (low === undefined || low < 0xdc00 || low > 0xdfff) return null;
      value += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    } else if (unit !== 0xfeff) {
      value += String.fromCodePoint(unit);
    }
  }
  return value;
}

function decodeMappedText(text: string, fontMap: FontUnicodeMap): string {
  let hex = '';
  for (const ch of text) {
    hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
  }
  return decodeMappedHex(hex, fontMap);
}

function decodeMappedHex(hex: string, fontMap: FontUnicodeMap): string {
  const clean = normalizeHex(hex);
  if (fontMap.codeLengths.length === 0) return decodeByteHex(clean);

  let value = '';
  let i = 0;
  while (i < clean.length) {
    const mappedLength = fontMap.codeLengths.find(
      (length) => i + length <= clean.length && fontMap.entries.has(clean.slice(i, i + length)),
    );
    if (mappedLength !== undefined) {
      value += fontMap.entries.get(clean.slice(i, i + mappedLength)) ?? '';
      i += mappedLength;
      continue;
    }

    const fallbackLength = fontMap.codeLengths.find((length) => i + length <= clean.length) ?? 2;
    value += decodeByteHex(clean.slice(i, i + fallbackLength));
    i += fallbackLength;
  }
  return value;
}

function decodeByteHex(hex: string): string {
  const clean = normalizeHex(hex);
  let value = '';
  for (let i = 0; i < clean.length; i += 2) {
    value += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return value;
}

function decodeUnicodeHex(hex: string): string {
  const clean = normalizeHex(hex);
  let value = '';
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const codePoint = parseInt(clean.slice(i, i + 4), 16);
    if (codePoint !== 0xfeff) value += String.fromCodePoint(codePoint);
  }
  return value;
}

function normalizeHex(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
  return clean.length % 2 === 0 ? clean : `${clean}0`;
}
