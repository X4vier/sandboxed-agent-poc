import type { AgentTool } from '../agent/types';
import { getOptionalBoolean, getOptionalInteger, getOptionalString, getString } from './inputs';
import { matchGlob, matchesGlobFilter } from './glob';

const READ_DEFAULT_LIMIT = 2000; // lines per Read call
const READ_MAX_LINE_CHARS = 2000; // per-line cap so one minified line can't flood context
const GREP_MATCH_CAP = 200;

const statusMarker: Record<string, string> = {
  provided: '[provided]',
  created: '[created] ',
  modified: '[modified]',
};

const LINE_TRUNC_MARKER = '… [line truncated]';

/** Truncate a single displayed line so a minified file can't blow the context. */
function capLine(line: string): string {
  return line.length > READ_MAX_LINE_CHARS
    ? line.slice(0, READ_MAX_LINE_CHARS) + LINE_TRUNC_MARKER
    : line;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = tmp;
    }
  }
  return row[n];
}

/** "Did you mean …?" suffix for a missing key, using the closest existing keys. */
function suggestKeys(target: string, keys: string[]): string {
  if (keys.length === 0) return '';
  const threshold = Math.max(3, Math.floor(target.length / 2));
  const near = keys
    .map((k) => ({ k, d: levenshtein(target, k) }))
    .filter((s) => s.d <= threshold)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((s) => s.k);
  return near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '';
}

function missingFile(key: string, ctx: { vfs: { keys(): string[] } }): string {
  return `File does not exist: "${key}".${suggestKeys(key, ctx.vfs.keys())}`;
}

export const readTool: AgentTool = {
  name: 'Read',
  description:
    'Read a UTF-8 text file from the workspace. Input: { "file_path": "<workspace-relative path>", ' +
    '"offset"?: <1-indexed start line>, "limit"?: <max lines, default 2000> }. ' +
    'Output is `cat -n` style: a right-aligned line number, a tab, then the line content. ' +
    'When a file is larger than the window, the result ends with a note telling you the offset to ' +
    'resume from. Lines longer than 2000 characters are truncated. Binary (non-UTF-8) files cannot ' +
    'be read as text — use read_document for PDFs/images/docx. Copy text for Edit from this output ' +
    'WITHOUT the line-number prefix.',
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
    const end = Math.min(lines.length, start + Math.max(1, limit) - 1);

    const body = lines
      .slice(start - 1, end)
      .map((line, idx) => `${String(start + idx).padStart(6)}\t${capLine(line)}`)
      .join('\n');

    if (end < lines.length) {
      return `${body}\n\n[showing lines ${start}-${end} of ${lines.length}; re-call with offset=${
        end + 1
      } to continue]`;
    }
    return body;
  },
};

export const writeTool: AgentTool = {
  name: 'Write',
  description:
    'Create a new file or completely overwrite an existing one. Input: { "file_path": ' +
    '"<workspace-relative path>", "content": "<full UTF-8 text>" }. Parent directories are implicit. ' +
    'Prefer Edit for changing part of an existing file; use Write for new files or full rewrites. ' +
    'Returns a confirmation with the byte size.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Full file contents (UTF-8).' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const path = getString(input, 'file_path');
    const content = getString(input, 'content');
    const key = ctx.vfs.writeFile(path, content);
    const size = Buffer.byteLength(content, 'utf-8');
    return `Wrote ${size} bytes to "${key}" (${ctx.vfs.status(key)}).`;
  },
};

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editTool: AgentTool = {
  name: 'Edit',
  description:
    'Replace an exact string in a text file. Input: { "file_path": "...", "old_string": "...", ' +
    '"new_string": "...", "replace_all"?: false }. Read the file first and copy old_string from the ' +
    'output WITHOUT the line-number prefix. old_string must be unique in the file unless replace_all ' +
    'is true, in which case every occurrence is replaced. old_string and new_string must differ.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Workspace-relative path.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence (default false).',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const key = ctx.normalizePath(getString(input, 'file_path'));
    const oldString = getString(input, 'old_string');
    const newString = getString(input, 'new_string');
    const replaceAll = getOptionalBoolean(input, 'replace_all');
    if (!ctx.vfs.has(key)) return missingFile(key, ctx);
    const decoded = ctx.vfs.readText(key);
    if (!decoded.ok) return `Cannot edit "${key}" — it is not UTF-8 text.`;
    if (oldString.length === 0) {
      return 'old_string must not be empty. Provide the exact text to replace.';
    }
    if (oldString === newString) {
      return 'No changes to make: old_string and new_string are exactly the same.';
    }
    const text = decoded.text;
    const count = countOccurrences(text, oldString);
    if (count === 0) {
      return 'String to replace not found in file. Read the file to copy the exact text (including whitespace) you want to replace.';
    }
    if (count > 1 && !replaceAll) {
      return `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one, include more surrounding context so old_string identifies exactly one location.`;
    }
    const updated = replaceAll
      ? text.split(oldString).join(newString)
      : text.slice(0, text.indexOf(oldString)) +
        newString +
        text.slice(text.indexOf(oldString) + oldString.length);
    ctx.vfs.writeFile(key, updated);
    const replaced = replaceAll ? count : 1;
    return `Edited "${key}" (${ctx.vfs.status(key)}). Replaced ${replaced} occurrence${
      replaced === 1 ? '' : 's'
    }.`;
  },
};

function underPath(key: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  return key === prefix || key.startsWith(`${prefix}/`);
}

export const listFilesTool: AgentTool = {
  name: 'list_files',
  description:
    'List workspace files recursively with byte sizes and status markers ' +
    '([provided]/[created]/[modified]). Input: { "path"?: "<optional directory prefix>" }. ' +
    'Prefer Glob when you are looking for files by name or pattern; this tool is for seeing ' +
    'everything in the workspace and its provided/created/modified state.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional directory prefix to list under.' },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const raw = getOptionalString(input, 'path');
    const prefix = raw ? ctx.normalizePath(raw) : undefined;
    const rows = ctx.vfs
      .list()
      .filter((f) => underPath(f.path, prefix))
      .map((f) => `${statusMarker[f.status] ?? '[?]'} ${String(f.size).padStart(9)}  ${f.path}`);
    if (rows.length === 0) {
      return prefix ? `No files under "${prefix}".` : 'The workspace is empty.';
    }
    return rows.join('\n');
  },
};

export const globTool: AgentTool = {
  name: 'Glob',
  description:
    'Find files by name using a glob pattern. Input: { "pattern": "<glob>", "path"?: "<dir scope>" }. ' +
    'Supports `*` (within a path segment), `?` (one character), `**` (across segments), and `{a,b}` ' +
    'sets — e.g. "**/*.csv", "src/**/*.{ts,tsx}". When path is given, the pattern is matched relative ' +
    'to that directory. Returns matching workspace-relative paths, sorted, one per line.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.csv".' },
      path: { type: 'string', description: 'Optional directory to scope the search to.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const pattern = getString(input, 'pattern');
    const rawPath = getOptionalString(input, 'path');
    const scope = rawPath ? ctx.normalizePath(rawPath) : undefined;
    const matches = matchGlob(ctx.vfs.keys(), pattern, scope);
    if (matches.length === 0) {
      return scope ? `No files matching "${pattern}" under "${scope}".` : `No files matching "${pattern}".`;
    }
    return matches.join('\n');
  },
};

const GREP_OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;
type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

export const grepTool: AgentTool = {
  name: 'Grep',
  description:
    'Search file contents with a regular expression. Input: { "pattern": "<regex>", "path"?: ' +
    '"<dir scope>", "glob"?: "<filename filter e.g. *.ts>", "-i"?: false, "output_mode"?: ' +
    '"content" }. pattern is ALWAYS a JavaScript regular expression (escape literal metacharacters). ' +
    'output_mode: "content" (default) returns "path:line: text"; "files_with_matches" returns matching ' +
    `paths only; "count" returns "path:count". Set "-i" for case-insensitive. Up to ${GREP_MATCH_CAP} ` +
    'results are returned, then a truncation note.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Optional directory prefix to search under.' },
      glob: { type: 'string', description: 'Optional filename filter, e.g. "*.ts".' },
      '-i': { type: 'boolean', description: 'Case-insensitive search.' },
      output_mode: {
        type: 'string',
        enum: [...GREP_OUTPUT_MODES],
        description: 'content | files_with_matches | count (default content).',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const pattern = getString(input, 'pattern');
    const rawPath = getOptionalString(input, 'path');
    const globFilter = getOptionalString(input, 'glob');
    const caseInsensitive = getOptionalBoolean(input, '-i');
    const outputMode = (getOptionalString(input, 'output_mode') ?? 'content') as GrepOutputMode;
    const prefix = rawPath ? ctx.normalizePath(rawPath) : undefined;

    if (!GREP_OUTPUT_MODES.includes(outputMode)) {
      return `Invalid output_mode "${outputMode}". Use one of: ${GREP_OUTPUT_MODES.join(', ')}.`;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
    } catch (e) {
      return `Invalid regular expression: ${(e as Error).message}`;
    }

    const results: string[] = [];
    let truncated = false;
    for (const key of ctx.vfs.keys()) {
      if (!underPath(key, prefix)) continue;
      if (globFilter && !matchesGlobFilter(key, globFilter)) continue;
      const decoded = ctx.vfs.readText(key);
      if (!decoded.ok) continue; // skip binary
      const lines = decoded.text.split('\n');
      let fileCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!regex.test(line)) continue;
        fileCount += 1;
        if (outputMode === 'content') {
          if (results.length >= GREP_MATCH_CAP) {
            truncated = true;
            break;
          }
          results.push(`${key}:${i + 1}: ${capLine(line)}`);
        }
      }
      if (truncated) break;
      if (fileCount > 0 && outputMode !== 'content') {
        if (results.length >= GREP_MATCH_CAP) {
          truncated = true;
          break;
        }
        results.push(outputMode === 'count' ? `${key}:${fileCount}` : key);
      }
    }

    if (results.length === 0) return 'No matches found.';
    const note = truncated ? `\n\n[truncated: first ${GREP_MATCH_CAP} results shown]` : '';
    return results.join('\n') + note;
  },
};
