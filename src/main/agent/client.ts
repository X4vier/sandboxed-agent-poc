import Anthropic from '@anthropic-ai/sdk';

/**
 * The ONLY place an Anthropic API client is constructed. To target Bedrock
 * later, change only this module (swap in AnthropicBedrock) — nothing else in
 * the codebase references the SDK constructor.
 */

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Set it in your environment before running a task.',
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const AGENT_MODEL = process.env['AGENT_MODEL'] ?? 'claude-sonnet-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Reasoning/effort level for the run, from AGENT_EFFORT (default 'medium'). */
export function getEffort(): Effort {
  const raw = process.env['AGENT_EFFORT'];
  return raw && (EFFORTS as readonly string[]).includes(raw) ? (raw as Effort) : 'medium';
}

export function getTokenBudgetLimit(): number {
  const raw = process.env['AGENT_TOKEN_BUDGET'];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500_000;
}
