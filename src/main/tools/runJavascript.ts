import { getQuickJS, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten';
import type { AgentTool, ToolContext } from '../agent/types';
import { getString } from './inputs';

const MEMORY_LIMIT = 256 * 1024 * 1024; // 256MB
const STACK_LIMIT = 1024 * 1024; // 1MB
const DEADLINE_MS = 30_000; // 30s wall clock
const OUTPUT_CAP = 64 * 1024; // 64KB returned to the model

/**
 * Marshal a native JSON-serializable value into a fresh guest handle owned by
 * the caller. Intermediate child handles are disposed as we go; the returned
 * handle must be handed straight back to the VM (never disposed by us — the VM
 * frees a newFunction's return value).
 */
function marshal(context: QuickJSContext, value: unknown): QuickJSHandle {
  if (typeof value === 'string') return context.newString(value);
  if (typeof value === 'number') return context.newNumber(value);
  if (Array.isArray(value)) {
    const arr = context.newArray();
    for (let i = 0; i < value.length; i++) {
      const child = marshal(context, value[i]);
      context.setProp(arr, String(i), child);
      child.dispose();
    }
    return arr;
  }
  if (value !== null && typeof value === 'object') {
    const obj = context.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = marshal(context, v);
      context.setProp(obj, k, child);
      child.dispose();
    }
    return obj;
  }
  return context.newString(String(value));
}

function display(value: unknown): string {
  if (value === undefined) return '(no value)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clamp(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= OUTPUT_CAP) return text;
  const sliced = Buffer.from(text, 'utf-8').subarray(0, OUTPUT_CAP).toString('utf-8');
  return `${sliced}\n\n[truncated: output exceeded ${OUTPUT_CAP} bytes]`;
}

async function runInGuest(code: string, ctx: ToolContext): Promise<string> {
  if (ctx.signal.aborted) return 'Error: run cancelled before execution.';

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const transcript: string[] = [];

  try {
    runtime.setMemoryLimit(MEMORY_LIMIT);
    runtime.setMaxStackSize(STACK_LIMIT);
    const deadline = Date.now() + DEADLINE_MS;
    runtime.setInterruptHandler(() => ctx.signal.aborted || Date.now() > deadline);

    const context = runtime.newContext();
    try {
      // Inject the capability-limited host functions. Handlers must not free
      // their argument handles or their return handles (the VM owns those).
      const readFileFn = context.newFunction('readFile', (pathHandle) => {
        const key = ctx.normalizePath(context.getString(pathHandle));
        const decoded = ctx.vfs.readText(key);
        if (!decoded.ok) throw new Error(`"${key}" is not UTF-8 text and cannot be read.`);
        return context.newString(decoded.text);
      });
      const writeFileFn = context.newFunction('writeFile', (pathHandle, contentHandle) => {
        const key = ctx.normalizePath(context.getString(pathHandle));
        ctx.vfs.writeFile(key, context.getString(contentHandle));
        // returns undefined
      });
      const listFilesFn = context.newFunction('listFiles', (pathHandle) => {
        let prefix: string | undefined;
        if (pathHandle && context.typeof(pathHandle) === 'string') {
          prefix = ctx.normalizePath(context.getString(pathHandle));
        }
        const rows = ctx.vfs
          .list()
          .filter((f) => !prefix || f.path === prefix || f.path.startsWith(`${prefix}/`))
          .map((f) => ({ path: f.path, size: f.size, status: f.status }));
        return marshal(context, rows);
      });
      const logFn = context.newFunction('log', (msgHandle) => {
        const v = context.dump(msgHandle);
        transcript.push(typeof v === 'string' ? v : display(v));
        // returns undefined
      });

      for (const [name, fn] of [
        ['readFile', readFileFn],
        ['writeFile', writeFileFn],
        ['listFiles', listFilesFn],
        ['log', logFn],
      ] as const) {
        context.setProp(context.global, name, fn);
        fn.dispose();
      }

      const result = context.evalCode(code);
      if (result.error) {
        const err = context.dump(result.error);
        result.error.dispose();
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : display(err);
        return clamp(formatOutput({ error: message, transcript }));
      }
      const value = context.dump(result.value);
      result.value.dispose();
      return clamp(formatOutput({ value, transcript }));
    } finally {
      context.dispose();
    }
  } catch (e) {
    return clamp(formatOutput({ error: (e as Error).message, transcript }));
  } finally {
    runtime.dispose();
  }
}

function formatOutput(o: {
  value?: unknown;
  error?: string;
  transcript: string[];
}): string {
  const parts: string[] = [];
  if (o.error !== undefined) {
    parts.push(`Error: ${o.error}`);
  } else {
    parts.push(`Completion value:\n${display(o.value)}`);
  }
  parts.push(`\nLog:\n${o.transcript.length > 0 ? o.transcript.join('\n') : '(empty)'}`);
  return parts.join('\n');
}

export const runJavascriptTool: AgentTool = {
  name: 'run_javascript',
  description:
    'Execute JavaScript in a sandboxed QuickJS (WASM) interpreter to compute over workspace files. ' +
    'Input: { "code": "<JavaScript source>" }. The completion value of the code, a log() transcript, ' +
    'and any thrown error are returned to you.\n\n' +
    'Injected host functions (synchronous):\n' +
    '  readFile(path) -> string           // UTF-8 contents; throws for missing/binary files\n' +
    '  writeFile(path, content) -> void    // create or overwrite a workspace file\n' +
    '  listFiles(path?) -> [{path,size,status}]  // workspace listing, optionally under a prefix\n' +
    '  log(message) -> void                // append to the transcript (there is no console)\n\n' +
    'Standard ECMAScript globals exist (Object, Array, JSON, Math, String, Number, Date, etc.). ' +
    'There is NO require, import, fetch, process, setTimeout/setInterval, console, or any network/file access ' +
    "beyond the four host functions above — they all evaluate to undefined. All paths are workspace-relative. " +
    'Limits: 256MB memory, 30s wall clock.',
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string', description: 'JavaScript source to execute.' } },
    required: ['code'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => runInGuest(getString(input, 'code'), ctx),
};
