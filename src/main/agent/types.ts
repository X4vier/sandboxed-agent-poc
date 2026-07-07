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
  /** Nesting depth of the current agent (0 = root, >0 = a spawned subagent). */
  depth: number;
  /**
   * Launch a subagent that shares this workspace, tool set, token budget, and
   * cancellation signal but gets its own fresh context window. Resolves to the
   * subagent's final report. Used by the Task tool to delegate self-contained
   * work without flooding the caller's context.
   */
  runSubagent(task: string): Promise<string>;
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
