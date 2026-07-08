import { mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentEvent } from '../shared/ipc';

const TOOL_RESULT_LIMIT = 2000;

export interface DebugLogStatus {
  active: boolean;
  fileName: string | null;
}

let configured = false;
let active = false;
let directory: string | null = null;
let handle: FileHandle | null = null;
let fileName: string | null = null;
let writes: Promise<void> = Promise.resolve();

function configureFromEnv(): void {
  if (configured) return;
  configured = true;
  const raw = process.env['AGENT_DEBUG_LOG']?.trim();
  if (!raw) return;
  active = true;
  directory = raw;
}

export function debugLogStatus(): DebugLogStatus {
  configureFromEnv();
  return { active, fileName };
}

export async function stopDebugLog(): Promise<DebugLogStatus> {
  configureFromEnv();
  active = false;
  await writes.catch(() => undefined);
  await closeHandle();
  return debugLogStatus();
}

export function logEvent(event: AgentEvent): void {
  configureFromEnv();
  if (!active) return;
  const record = { timestamp: new Date().toISOString(), kind: 'event', event: scrubEvent(event) };
  enqueue(async () => {
    if (!handle) return;
    await writeJsonLine(record);
  });
}

export function logLine(scope: string, message: string): void {
  configureFromEnv();
  if (!active) return;
  const record = { timestamp: new Date().toISOString(), kind: 'line', scope, message };
  if (scope === 'run_start') {
    const next = nextLogPath();
    fileName = next.name;
    enqueue(async () => {
      await closeHandle();
      if (!directory) return;
      await mkdir(directory, { recursive: true });
      handle = await open(next.path, 'a');
      await writeJsonLine(record);
    });
    return;
  }

  const closeAfter = scope === 'run_end' || scope === 'run_error';
  enqueue(async () => {
    if (!handle) return;
    await writeJsonLine(record);
    if (closeAfter) await closeHandle();
  });
}

function enqueue(work: () => Promise<void>): void {
  writes = writes.then(work).catch(async (error: unknown) => {
    await closeHandle().catch(() => undefined);
    active = false;
    console.warn(`Debug log disabled: ${(error as Error).message}`);
  });
}

async function closeHandle(): Promise<void> {
  const h = handle;
  handle = null;
  if (h) await h.close();
}

async function writeJsonLine(record: unknown): Promise<void> {
  if (!handle) return;
  await handle.writeFile(`${JSON.stringify(record)}\n`);
}

function nextLogPath(): { path: string; name: string } {
  if (!directory) throw new Error('Debug log directory is not configured.');
  const iso = new Date().toISOString();
  const timestamp = process.platform === 'win32' ? iso.replace(/:/g, '-') : iso;
  const name = `agent-run-${timestamp}.jsonl`;
  return { path: join(directory, name), name: basename(name) };
}

function scrubEvent(event: AgentEvent): AgentEvent | (AgentEvent & { resultTruncated: true; originalResultLength: number }) {
  if (event.type !== 'tool_result' || event.result.length <= TOOL_RESULT_LIMIT) return event;
  return {
    ...event,
    result: event.result.slice(0, TOOL_RESULT_LIMIT),
    resultTruncated: true,
    originalResultLength: event.result.length,
  };
}
