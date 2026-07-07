import type { ReadWindow } from './types';

/**
 * Bound a block of extracted text to one {@link ReadWindow}, so no single read
 * floods the context. Windows by line offset like Claude Code's Read, but also
 * caps total characters — extracted prose (especially from .docx) can be a few
 * enormous lines, which a line count alone would not bound. A footer names the
 * offset to resume from when more remains; at least one line is always returned
 * so an oversized line still makes progress.
 */

const DEFAULT_LINE_LIMIT = 2000; // lines per call
const MAX_LINE_CHARS = 2000; // per-line cap so one huge line can't flood context
const CHAR_BUDGET = 60_000; // ~15k tokens of prose per call, whichever hits first
const LINE_TRUNC_MARKER = '… [line truncated]';

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + LINE_TRUNC_MARKER : line;
}

export function windowText(text: string, name: string, { offset, limit }: ReadWindow): string {
  const lines = text.split('\n');
  const start = Math.max(1, offset);
  if (start > lines.length) {
    return `offset ${start} is past the end of "${name}", which has ${lines.length} line(s).`;
  }
  const maxLine = Math.min(lines.length, start + Math.max(1, limit ?? DEFAULT_LINE_LIMIT) - 1);
  const out: string[] = [];
  let chars = 0;
  let lastLine = start - 1;
  for (let i = start - 1; i < maxLine; i++) {
    const line = capLine(lines[i]);
    if (out.length > 0 && chars + line.length > CHAR_BUDGET) break;
    out.push(line);
    chars += line.length + 1;
    lastLine = i + 1;
  }
  const body = out.join('\n');
  if (lastLine < lines.length) {
    return `${body}\n\n[showing lines ${start}-${lastLine} of ${lines.length}; re-call with offset=${
      lastLine + 1
    } to continue]`;
  }
  return body;
}
