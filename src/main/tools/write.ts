import type { AgentTool } from '../agent/types';
import { getString } from './inputs';

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
