import Anthropic from '@anthropic-ai/sdk';

/**
 * The ONLY place an Anthropic API client is constructed. To target Bedrock
 * later, change only this module (swap in AnthropicBedrock) — nothing else in
 * the codebase references the SDK constructor.
 */

/**
 * The API key lives only in this module-level variable, held in memory for the
 * lifetime of the process. It is never written to disk and is discarded when
 * the app closes. The user supplies it through the UI at startup (see the
 * `agent:setApiKey` IPC handler); an ambient ANTHROPIC_API_KEY, if present, is
 * used as a dev-only seed so contributors need not retype it each launch.
 */
let apiKey: string | null = process.env['ANTHROPIC_API_KEY']?.trim() || null;
let client: Anthropic | null = null;

/** Store an ephemeral API key for this session and reset the cached client. */
export function setApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key must not be empty.');
  apiKey = trimmed;
  client = null;
}

/** Discard the in-memory key (e.g. when the user chooses to change it). */
export function clearApiKey(): void {
  apiKey = null;
  client = null;
}

/** Whether a key is currently available to construct a client. */
export function hasApiKey(): boolean {
  return apiKey !== null;
}

export function getClient(): Anthropic {
  if (!client) {
    if (!apiKey) {
      throw new Error('No Anthropic API key set. Enter your key to run a task.');
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
