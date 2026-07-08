import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/shared/ipc';

type DebugLogModule = typeof import('../src/main/debugLog');

let current: DebugLogModule | null = null;

async function loadDebugLog(dir?: string): Promise<DebugLogModule> {
  vi.resetModules();
  if (dir) process.env['AGENT_DEBUG_LOG'] = dir;
  else delete process.env['AGENT_DEBUG_LOG'];
  current = await import('../src/main/debugLog');
  return current;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-debug-log-'));
}

async function readJsonl(dir: string): Promise<unknown[]> {
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^agent-run-.*\.jsonl$/);
  const text = await readFile(join(dir, files[0]!), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'assistant_text_delta',
    text: 'hello',
    agentId: 'root',
    parentAgentId: null,
    depth: 0,
    ...overrides,
  } as AgentEvent;
}

afterEach(async () => {
  await current?.stopDebugLog();
  current = null;
  delete process.env['AGENT_DEBUG_LOG'];
  vi.resetModules();
});

describe('debugLog', () => {
  it('stays disabled when AGENT_DEBUG_LOG is unset', async () => {
    const dir = await tempDir();
    const log = await loadDebugLog();

    expect(log.debugLogStatus()).toEqual({ active: false, fileName: null });
    log.logLine('run_start', 'ignored');
    log.logEvent(event());
    await log.stopDebugLog();

    expect(await readdir(dir)).toEqual([]);
  });

  it('writes timestamped JSONL line and event records', async () => {
    const dir = await tempDir();
    const log = await loadDebugLog(dir);

    log.logLine('run_start', JSON.stringify({ task: 'Summarize', model: 'claude-sonnet-5', fileCount: 2 }));
    const status = log.debugLogStatus();
    expect(status.active).toBe(true);
    expect(status.fileName).toMatch(/^agent-run-.*\.jsonl$/);
    log.logEvent(event({
      type: 'turn_complete',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 3,
      },
    }));
    log.logLine('run_end', JSON.stringify({ status: 'completed' }));
    await log.stopDebugLog();

    const records = await readJsonl(dir);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ kind: 'line', scope: 'run_start' });
    expect(records[1]).toMatchObject({ kind: 'event', event: { type: 'turn_complete' } });
    expect(records[2]).toMatchObject({ kind: 'line', scope: 'run_end' });
    for (const record of records) expect((record as { timestamp: string }).timestamp).toEqual(expect.any(String));
  });

  it('truncates tool_result payloads and records the original length', async () => {
    const dir = await tempDir();
    const log = await loadDebugLog(dir);
    const result = 'x'.repeat(2500);

    log.logLine('run_start', 'start');
    log.logEvent(event({
      type: 'tool_result',
      id: 'toolu_1',
      name: 'Read',
      result,
      isError: false,
    }));
    log.logLine('run_end', 'end');
    await log.stopDebugLog();

    const records = await readJsonl(dir);
    const logged = records[1] as { event: { result: string; resultTruncated: true; originalResultLength: number } };
    expect(logged.event.result).toHaveLength(2000);
    expect(logged.event.resultTruncated).toBe(true);
    expect(logged.event.originalResultLength).toBe(2500);
  });

  it('stop closes the file and prevents later writes', async () => {
    const dir = await tempDir();
    const log = await loadDebugLog(dir);

    log.logLine('run_start', 'start');
    log.logEvent(event({ text: 'before stop' }));
    expect(await log.stopDebugLog()).toEqual({ active: false, fileName: expect.any(String) });
    log.logEvent(event({ text: 'after stop' }));
    log.logLine('run_end', 'end');

    const records = await readJsonl(dir);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ event: { text: 'before stop' } });
  });
});
