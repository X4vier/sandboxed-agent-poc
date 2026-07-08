import { describe, it, expect } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { compact, shouldCompact, DEFAULT_COMPACTION_SETTINGS } from '../src/main/agent/compaction';
import { createFakeEngine } from './fakeEngine';

const SETTINGS = { thresholdFraction: 0.8, summaryMaxTokens: 4000 };

describe('shouldCompact', () => {
  it('triggers only strictly above the window fraction', () => {
    // 100 * 0.8 = 80
    expect(shouldCompact(79, 100, SETTINGS)).toBe(false);
    expect(shouldCompact(80, 100, SETTINGS)).toBe(false);
    expect(shouldCompact(81, 100, SETTINGS)).toBe(true);
  });

  it('scales with the window and the fraction', () => {
    expect(shouldCompact(150_000, 200_000, SETTINGS)).toBe(false); // 160k threshold
    expect(shouldCompact(170_000, 200_000, SETTINGS)).toBe(true);
    expect(shouldCompact(51, 100, { ...SETTINGS, thresholdFraction: 0.5 })).toBe(true);
  });
});

describe('compact', () => {
  it('replaces history with one summarized user turn and leaves no orphaned tool blocks', async () => {
    const engine = createFakeEngine();
    engine.push({
      text: 'SUMMARY: wrote a.txt with the results.',
      stopReason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    // A realistic transcript ending in a tool_use / tool_result pair.
    const messages: MessageParam[] = [
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];

    const result = await compact(
      engine,
      { system: 'sys', tools: [], messages, task: 'original task' },
      DEFAULT_COMPACTION_SETTINGS,
      new AbortController().signal,
    );

    // The replacement is a single user turn — no tool_use/tool_result survive to
    // be orphaned, and the original task + summary are both present.
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('user');
    const content = result.messages[0]?.content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('original task');
    expect(content as string).toContain('SUMMARY: wrote a.txt');

    // The summarization call is billed back and forbids tool calls.
    expect(result.usage.input_tokens).toBe(50);
    expect(engine.requests[0]?.toolChoice).toBe('none');
    expect(engine.requests[0]?.maxTokens).toBe(DEFAULT_COMPACTION_SETTINGS.summaryMaxTokens);

    // The summarization instruction was appended to the trailing tool-result turn,
    // and the historical tool_result block was preserved so the request validates.
    const sentLast = engine.requests[0]?.messages.at(-1);
    const blocks = sentLast?.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === 'text' && b.text?.includes('You are about to run out'))).toBe(true);
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(true);
  });
});
