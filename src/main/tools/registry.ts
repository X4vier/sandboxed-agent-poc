import type { AgentTool, ToolContext } from '../agent/types';

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: AgentTool['inputSchema'];
}

/** Holds the available tools and executes them by name. */
export class ToolRegistry {
  private readonly byName = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) {
        throw new Error(`Duplicate tool registered: ${tool.name}`);
      }
      this.byName.set(tool.name, tool);
    }
  }

  list(): AgentTool[] {
    return [...this.byName.values()];
  }

  /** Tool definitions in the shape the Anthropic Messages API expects. */
  toApiTools(): AnthropicToolDef[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * Execute a tool by name. A missing tool or a thrown handler both resolve to
   * a string result (never a rejection) so the agent loop can surface it to the
   * model as an is_error tool_result without crashing.
   */
  async execute(name: string, input: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) {
      return `Unknown tool "${name}". Available tools: ${[...this.byName.keys()].join(', ')}.`;
    }
    return tool.handler(input, ctx);
  }
}
