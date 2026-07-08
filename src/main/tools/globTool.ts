import type { AgentTool } from '../agent/types';
import { getOptionalString, getString } from './inputs';
import { matchGlob } from './glob';

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
