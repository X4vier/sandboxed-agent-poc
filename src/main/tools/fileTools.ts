import type { AgentTool } from '../agent/types';
import { getOptionalBoolean, getOptionalString, getString } from './inputs';

const READ_CAP_BYTES = 256 * 1024;
const SEARCH_MATCH_CAP = 200;

const statusMarker: Record<string, string> = {
  provided: '[provided]',
  created: '[created] ',
  modified: '[modified]',
};

export const readFileTool: AgentTool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Input: { "path": "<workspace-relative path>" }. ' +
    `Returns the file contents, capped at ${READ_CAP_BYTES} bytes per read; if larger, the result ends ` +
    'with a truncation note. Binary (non-UTF-8) files cannot be read as text.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const key = ctx.normalizePath(getString(input, 'path'));
    const decoded = ctx.vfs.readText(key);
    if (!decoded.ok) {
      return `Cannot read "${key}" as UTF-8 text — it appears to be binary (${decoded.size} bytes). Binary files can be exported unchanged but not read or edited as text.`;
    }
    const buf = ctx.vfs.readBuffer(key);
    if (buf.length > READ_CAP_BYTES) {
      const shown = new TextDecoder('utf-8').decode(buf.subarray(0, READ_CAP_BYTES));
      return `${shown}\n\n[truncated: showing first ${READ_CAP_BYTES} of ${buf.length} bytes]`;
    }
    return decoded.text;
  },
};

export const writeFileTool: AgentTool = {
  name: 'write_file',
  description:
    'Create a new file or overwrite an existing one. Input: { "path": "<workspace-relative path>", ' +
    '"content": "<full UTF-8 text>" }. Parent directories are implicit. Returns a confirmation with the byte size.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Full file contents (UTF-8).' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const path = getString(input, 'path');
    const content = getString(input, 'content');
    const key = ctx.vfs.writeFile(path, content);
    const size = Buffer.byteLength(content, 'utf-8');
    return `Wrote ${size} bytes to "${key}" (${ctx.vfs.status(key)}).`;
  },
};

export const editFileTool: AgentTool = {
  name: 'edit_file',
  description:
    'Replace an exact substring in a text file. Input: { "path": "...", "old_string": "...", "new_string": "..." }. ' +
    'old_string must appear EXACTLY ONCE in the file. If it is missing or appears multiple times, the edit fails ' +
    'and you should retry with more surrounding context to make old_string unique.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      old_string: { type: 'string', description: 'Exact text to find (must be unique).' },
      new_string: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const key = ctx.normalizePath(getString(input, 'path'));
    const oldString = getString(input, 'old_string');
    const newString = getString(input, 'new_string');
    const decoded = ctx.vfs.readText(key);
    if (!decoded.ok) {
      return `Cannot edit "${key}" — it is not UTF-8 text.`;
    }
    const text = decoded.text;
    if (oldString.length === 0) {
      return 'old_string must not be empty. Provide the exact text to replace.';
    }
    const first = text.indexOf(oldString);
    if (first === -1) {
      return `old_string was not found in "${key}". Read the file to copy the exact text (including whitespace) you want to replace.`;
    }
    const second = text.indexOf(oldString, first + 1);
    if (second !== -1) {
      return `old_string matches more than once in "${key}". Include more surrounding context so it identifies exactly one location.`;
    }
    const updated = text.slice(0, first) + newString + text.slice(first + oldString.length);
    ctx.vfs.writeFile(key, updated);
    return `Edited "${key}" (${ctx.vfs.status(key)}). Replaced 1 occurrence.`;
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
    '([provided]/[created]/[modified]). Input: { "path"?: "<optional directory prefix>" }.',
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

export const searchFilesTool: AgentTool = {
  name: 'search_files',
  description:
    'Search text files line-by-line. Input: { "pattern": "...", "path"?: "<dir prefix>", "is_regex"?: false }. ' +
    `Returns up to ${SEARCH_MATCH_CAP} matches as "path:line: text". Binary files are skipped. ` +
    'When is_regex is true, pattern is a JavaScript regular expression.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Substring or regular expression to find.' },
      path: { type: 'string', description: 'Optional directory prefix to search under.' },
      is_regex: { type: 'boolean', description: 'Treat pattern as a regular expression.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const pattern = getString(input, 'pattern');
    const rawPath = getOptionalString(input, 'path');
    const isRegex = getOptionalBoolean(input, 'is_regex');
    const prefix = rawPath ? ctx.normalizePath(rawPath) : undefined;

    let regex: RegExp | null = null;
    if (isRegex) {
      try {
        regex = new RegExp(pattern);
      } catch (e) {
        return `Invalid regular expression: ${(e as Error).message}`;
      }
    }

    const matches: string[] = [];
    let truncated = false;
    for (const key of ctx.vfs.keys()) {
      if (!underPath(key, prefix)) continue;
      const decoded = ctx.vfs.readText(key);
      if (!decoded.ok) continue; // skip binary
      const lines = decoded.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const hit = regex ? regex.test(line) : line.includes(pattern);
        if (!hit) continue;
        if (matches.length >= SEARCH_MATCH_CAP) {
          truncated = true;
          break;
        }
        matches.push(`${key}:${i + 1}: ${line}`);
      }
      if (truncated) break;
    }
    if (matches.length === 0) return 'No matches.';
    const note = truncated ? `\n\n[truncated: first ${SEARCH_MATCH_CAP} matches shown]` : '';
    return matches.join('\n') + note;
  },
};
