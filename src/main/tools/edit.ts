import type { AgentTool } from '../agent/types';
import { getOptionalBoolean, getString } from './inputs';
import { missingFile } from './pathUtils';

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
