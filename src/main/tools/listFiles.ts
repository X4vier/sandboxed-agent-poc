import type { AgentTool } from '../agent/types';
import { getOptionalString } from './inputs';
import { underPath } from './pathUtils';

const statusMarker: Record<string, string> = {
  provided: '[provided]',
  created: '[created] ',
  modified: '[modified]',
};

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
