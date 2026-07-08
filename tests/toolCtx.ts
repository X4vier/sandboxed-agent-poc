import { VirtualWorkspace } from '../src/main/workspace/VirtualWorkspace';
import { normalizeWorkspacePath } from '../src/main/workspace/normalizePath';
import type { ToolContext } from '../src/main/agent/types';

/** A minimal ToolContext for exercising a single tool handler in isolation. */
export function makeCtx(vfs = new VirtualWorkspace()): ToolContext {
  return {
    vfs,
    normalizePath: normalizeWorkspacePath,
    emit: () => {},
    signal: new AbortController().signal,
    attachBlocks: () => {},
    depth: 0,
    agentId: 'root',
    parentAgentId: null,
    runSubagent: async () => '',
  };
}
