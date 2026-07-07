import { inflateSync, inflateRawSync } from 'node:zlib';
import type { Extraction, Extractor, SourceFile } from '../types';

/**
 * Naive PDF text extraction, no third-party dependencies.
 *
 * Strategy:
 *   1. locate the file's `stream … endstream` regions;
 *   2. inflate FlateDecode compression (the common case) via Node's zlib;
 *   3. pull operands out of the text-showing operators (Tj, TJ, ', ").
 *
 * This is good enough for most digitally-generated PDFs. It deliberately does
 * NOT handle:
 *   - font CMap / ToUnicode remapping — subset fonts may extract as garbage;
 *   - object streams (/ObjStm) that pack content objects together;
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
  for (const stream of contentStreams(pdf)) {
    const decoded = inflate(stream) ?? stream;
    const text = decoded.toString('latin1');
    if (!text.includes('BT')) continue; // skip font/image/metadata streams
    const extracted = extractTextOperators(text);
    if (extracted.trim()) pieces.push(extracted);
  }
  return pieces.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Yield the raw bytes of each `stream … endstream` region. */
function* contentStreams(pdf: Buffer): Generator<Buffer> {
  const s = pdf.toString('latin1');
  // `stream` not preceded by a letter (so we don't match the one inside
  // `endstream`), followed by an EOL. Stream data begins after that EOL.
  const re = /(?:^|[^A-Za-z])stream(?:\r\n|\r|\n)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    const dataStart = match.index + match[0].length;
    const end = s.indexOf('endstream', dataStart);
    if (end === -1) break;
    // Trim the single EOL that precedes `endstream`.
    let dataEnd = end;
    if (s[dataEnd - 1] === '\n') dataEnd--;
    if (s[dataEnd - 1] === '\r') dataEnd--;
    yield pdf.subarray(dataStart, dataEnd);
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
function extractTextOperators(content: string): string {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '(') {
      const parsed = readLiteralString(content, i);
      out += parsed.value;
      i = parsed.next;
    } else if (ch === '<' && content[i + 1] === '<') {
      i += 2; // inline dictionary opener — skip
    } else if (ch === '<') {
      const parsed = readHexString(content, i);
      out += parsed.value;
      i = parsed.next;
    } else if (isOperatorStart(ch)) {
      let op = '';
      let j = i;
      while (j < n && isOperatorChar(content[j])) {
        op += content[j];
        j++;
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
function readHexString(content: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let hex = '';
  const n = content.length;
  while (i < n && content[i] !== '>') {
    if (/[0-9A-Fa-f]/.test(content[i])) hex += content[i];
    i++;
  }
  if (i < n) i++; // consume '>'
  if (hex.length % 2 === 1) hex += '0';
  let value = '';
  for (let k = 0; k < hex.length; k += 2) {
    value += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  }
  return { value, next: i };
}
