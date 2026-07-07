import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
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
  /**
   * Queue rich content blocks (images, PDFs) to be appended to the user turn
   * that carries this batch of tool results. Used by tools that surface media
   * to the model rather than plain text.
   */
  attachBlocks(blocks: ContentBlockParam[]): void;
}

export interface AgentTool<In = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler(input: In, ctx: ToolContext): Promise<string>;
}

/** Shared, mutable cumulative token counter across an entire agent tree. */
export class TokenBudget {
  inputTokens = 0;
  outputTokens = 0;
  constructor(public readonly limit: number) {}

  add(inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }

  get used(): number {
    return this.inputTokens + this.outputTokens;
  }

  get exceeded(): boolean {
    return this.used >= this.limit;
  }

  snapshot(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.used,
    };
  }
}
