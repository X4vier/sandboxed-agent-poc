import type { AgentEvent } from '../../shared/ipc';
import type { VirtualWorkspace } from '../workspace/VirtualWorkspace';

/** Minimal JSON Schema shape for tool input definitions (hand-written). */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Everything a tool handler may touch. Tools reach the OS ONLY through this. */
export interface ToolContext {
  vfs: VirtualWorkspace;
  normalizePath(p: string): string;
  emit(event: AgentEvent): void;
  signal: AbortSignal;
}

export interface AgentTool<In = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler(input: In, ctx: ToolContext): Promise<string>;
}

/** Shared, mutable cumulative token counter across an entire agent tree. */
export class TokenBudget {
  used = 0;
  constructor(public readonly limit: number) {}

  add(inputTokens: number, outputTokens: number): void {
    this.used += inputTokens + outputTokens;
  }

  get exceeded(): boolean {
    return this.used >= this.limit;
  }
}
