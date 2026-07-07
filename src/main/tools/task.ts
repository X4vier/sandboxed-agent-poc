import type { AgentTool } from '../agent/types';
import { getString } from './inputs';

/**
 * Deepest subagent nesting allowed. Root runs at depth 0; a subagent it spawns
 * runs at depth 1. With this cap set to 2, a depth-1 subagent may still spawn a
 * depth-2 subagent, but a depth-2 subagent may not spawn further — a backstop
 * against runaway fan-out and cost, since the whole tree shares one token
 * budget.
 */
export const MAX_SUBAGENT_DEPTH = 2;

export const taskTool: AgentTool = {
  name: 'Task',
  description:
    'Delegate a self-contained piece of work to a subagent. Input: { "description": "<3-5 word ' +
    'label>", "prompt": "<complete, standalone instructions>" }. The subagent gets its OWN fresh ' +
    'context window and the same tools operating on this SAME in-memory workspace (files it creates ' +
    'or edits persist for you). It runs autonomously and cannot ask you or the user questions, so the ' +
    'prompt must be fully self-contained — state exactly what to do and what to report back. The ' +
    "subagent's single final message is returned to you as this tool's result. Use it to keep " +
    'context-heavy investigation out of your own window, or to handle independent sub-tasks. Multiple ' +
    'Task calls in the same response run in parallel, so use them to fan out independent investigation; ' +
    'avoid having parallel subagents write to the same file. Do the work directly when it is quick.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short 3-5 word label for the subagent task.' },
      prompt: {
        type: 'string',
        description: 'Complete, standalone instructions and the report you want back.',
      },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const description = getString(input, 'description').trim();
    const prompt = getString(input, 'prompt').trim();
    if (description.length === 0) {
      throw new Error('Parameter "description" must be a non-empty string.');
    }
    if (prompt.length === 0) {
      throw new Error('Parameter "prompt" must be a non-empty string.');
    }
    if (ctx.depth >= MAX_SUBAGENT_DEPTH) {
      return `Cannot launch a subagent: maximum nesting depth (${MAX_SUBAGENT_DEPTH}) reached. Complete this work yourself with the other tools.`;
    }
    return ctx.runSubagent(prompt);
  },
};
