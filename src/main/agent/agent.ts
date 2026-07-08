import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { AgentEvent } from './events';
import type { VirtualWorkspace } from '../workspace/VirtualWorkspace';
import type { CompletionEngine } from './engine';
import { runAgent } from './loop';
import type { AgentTool, TokenBudget } from './types';

/** How a {@link PendingMessageQueue} releases its contents on {@link PendingMessageQueue.drain}. */
export type QueueMode = 'all' | 'one-at-a-time';

/**
 * A small FIFO of user messages waiting to be injected into a run. Ported from
 * the Pi project's `Agent` (MIT). `'all'` drains everything at once (follow-ups
 * that start the next run together); `'one-at-a-time'` releases a single message
 * per drain (steering, injected one per turn boundary).
 */
class PendingMessageQueue {
  private messages: MessageParam[] = [];
  public mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: MessageParam): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  drain(): MessageParam[] {
    if (this.mode === 'all') {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }

    const first = this.messages[0];
    if (!first) {
      return [];
    }
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}

export interface AgentOptions {
  /** The in-memory workspace this conversation operates on (persists across turns). */
  vfs: VirtualWorkspace;
  /** The text-completion engine every run of this conversation streams through. */
  engine: CompletionEngine;
  /** The tool set handed to every run of this conversation. */
  tools: AgentTool[];
  /** Cumulative token usage across the whole conversation (for reporting). */
  budget: TokenBudget;
  /** Sink for streamed agent events, forwarded to the renderer over IPC. */
  emit: (event: AgentEvent) => void;
}

function messageText(content: MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function userMessage(text: string): MessageParam {
  return { role: 'user', content: text };
}

/**
 * A stateful, single-conversation wrapper around the stateless {@link runAgent}
 * loop. Modeled on the `Agent` class from the MIT-licensed Pi project, trimmed to
 * this app's Anthropic-only, event-over-IPC shape.
 *
 * The session owns the conversation transcript and context-window fill that the
 * loop previously round-tripped through `priorMessages` / `onConversationState`,
 * plus two message queues:
 *
 * - a **steering** queue (one-at-a-time) whose messages are injected into the
 *   *running* agent at turn boundaries via the loop's `drainSteering` hook, and
 * - a **follow-up** queue (all) whose messages start the *next* run once the
 *   current one finishes cleanly.
 *
 * Exactly one run is active at a time (`activeRun`); the loop's compaction and
 * subagent behavior are untouched.
 */
export class Agent {
  private messages: MessageParam[] = [];
  private contextTokens = 0;
  private readonly steeringQueue = new PendingMessageQueue('one-at-a-time');
  private readonly followUpQueue = new PendingMessageQueue('all');
  private activeRun: { abort: AbortController; done: Promise<void> } | undefined = undefined;

  constructor(private readonly opts: AgentOptions) {}

  /** True while a run is in flight. */
  isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  /**
   * Send a user message. If the session is idle this starts a new run; if a run
   * is active the message is queued as a follow-up and starts the next run once
   * the current one finishes cleanly.
   */
  prompt(text: string): void {
    if (this.isRunning()) {
      this.followUpQueue.enqueue(userMessage(text));
      return;
    }
    this.startRun(text);
  }

  /**
   * Steer the active run: the message is injected at the next turn boundary of
   * the run that is already going. If the session is idle this is equivalent to
   * {@link prompt} (it just starts a run).
   */
  steer(text: string): void {
    if (this.isRunning()) {
      this.steeringQueue.enqueue(userMessage(text));
      return;
    }
    this.startRun(text);
  }

  /** Abort the active run (if any) and discard all queued messages. */
  stop(): void {
    this.activeRun?.abort.abort();
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  /**
   * Resolve once the session is fully idle — the active run and any follow-up
   * runs it chains into have all settled. Callers (the IPC layer) await this to
   * know the conversation has come to rest.
   */
  async waitUntilIdle(): Promise<void> {
    let run = this.activeRun;
    while (run) {
      await run.done;
      run = this.activeRun;
    }
  }

  private startRun(task: string): void {
    const abort = new AbortController();
    // Kick off the run synchronously so `activeRun` is assigned before any of the
    // loop's awaited continuations resume. The IIFE settles cleanly even on error
    // (the loop already emits an 'error' event for the renderer), so `done` never
    // rejects and `waitUntilIdle` can simply await it.
    const done = (async () => {
      let clean = false;
      try {
        await this.runOnce(task, abort.signal);
        clean = true;
      } catch {
        // Swallowed: runAgent emitted the terminal event already.
      } finally {
        this.activeRun = undefined;
      }
      // Only a clean, un-aborted completion drains follow-ups into the next run.
      if (clean && !abort.signal.aborted && this.followUpQueue.hasItems()) {
        const next = this.followUpQueue.drain().map((m) => messageText(m.content)).join('\n\n');
        this.startRun(next);
      }
    })();
    this.activeRun = { abort, done };
  }

  private async runOnce(task: string, signal: AbortSignal): Promise<void> {
    await runAgent({
      task,
      tools: this.opts.tools,
      vfs: this.opts.vfs,
      engine: this.opts.engine,
      emit: this.opts.emit,
      signal,
      depth: 0,
      agentId: 'root',
      parentAgentId: null,
      budget: this.opts.budget,
      ...(this.messages.length > 0
        ? { priorMessages: this.messages, priorContextTokens: this.contextTokens }
        : {}),
      onConversationState: (messages, contextTokens) => {
        this.messages = messages;
        this.contextTokens = contextTokens;
      },
      drainSteering: () => this.steeringQueue.drain(),
    });
  }
}
