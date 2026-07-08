import type { AgentTool } from '../agent/types';
import { getOptionalInteger, getString } from './inputs';
import { missingFile } from './pathUtils';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate';

const READ_DEFAULT_LIMIT = 2000; // lines per Read call
const READ_MAX_LINE_CHARS = 2000; // per-line cap so one minified line can't flood context
const LINE_TRUNC_MARKER = '… [line truncated]';

/** Truncate a single displayed line so a minified file can't blow the context. */
function capLine(line: string): string {
  return line.length > READ_MAX_LINE_CHARS
    ? line.slice(0, READ_MAX_LINE_CHARS) + LINE_TRUNC_MARKER
    : line;
}

export const readTool: AgentTool = {
  name: 'Read',
  description:
    'Read a UTF-8 text file from the workspace. Input: { "file_path": "<workspace-relative path>", ' +
    '"offset"?: <1-indexed start line>, "limit"?: <max lines, default 2000> }. ' +
    'Output is `cat -n` style: a right-aligned line number, a tab, then the line content. ' +
    'A single read returns at most 2000 lines or 50KB, whichever is hit first; when there is more, ' +
    'the result ends with a note telling you the offset to resume from. Lines longer than 2000 ' +
    'characters are truncated. Binary (non-UTF-8) files cannot be read as text — use read_document ' +
    'for PDFs/images/docx. Copy text for Edit from this output WITHOUT the line-number prefix.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Workspace-relative path.' },
      offset: { type: 'number', description: '1-indexed line to start reading from.' },
      limit: { type: 'number', description: 'Maximum number of lines to read (default 2000).' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const key = ctx.normalizePath(getString(input, 'file_path'));
    if (!ctx.vfs.has(key)) return missingFile(key, ctx);
    const decoded = ctx.vfs.readText(key);
    if (!decoded.ok) {
      return `Cannot read "${key}" as UTF-8 text — it appears to be binary (${decoded.size} bytes). Use read_document for PDFs, images, and Office documents; binary files can be exported unchanged but not read as text.`;
    }
    if (decoded.text.length === 0) return `"${key}" is an empty file.`;

    const lines = decoded.text.split('\n');
    const offset = getOptionalInteger(input, 'offset') ?? 1;
    const limit = getOptionalInteger(input, 'limit') ?? READ_DEFAULT_LIMIT;
    const start = Math.max(1, offset);
    if (start > lines.length) {
      return `offset ${start} is past the end of "${key}", which has ${lines.length} line(s).`;
    }

    // Apply the line + byte caps to the window starting at `offset`, whichever
    // hits first, keeping only complete lines.
    const windowText = lines.slice(start - 1).join('\n');
    const trunc = truncateHead(windowText, { maxLines: Math.max(1, limit), maxBytes: DEFAULT_MAX_BYTES });

    if (trunc.firstLineExceedsLimit) {
      const bytes = Buffer.byteLength(lines[start - 1], 'utf-8');
      return `Line ${start} of "${key}" is ${formatSize(bytes)}, larger than the ${formatSize(
        DEFAULT_MAX_BYTES,
      )} per-read limit, so it cannot be shown. Use Grep to find specific text within it.`;
    }

    const shownLines = trunc.content.length === 0 ? [] : trunc.content.split('\n');
    const end = start + trunc.outputLines - 1;
    const body = shownLines
      .map((line, idx) => `${String(start + idx).padStart(6)}\t${capLine(line)}`)
      .join('\n');

    if (trunc.truncated && end < lines.length) {
      const reason = trunc.truncatedBy === 'bytes' ? `the ${formatSize(DEFAULT_MAX_BYTES)} byte cap` : `${limit} lines`;
      return `${body}\n\n[showing lines ${start}-${end} of ${lines.length} (hit ${reason}); re-call with offset=${
        end + 1
      } to continue]`;
    }
    return body;
  },
};
