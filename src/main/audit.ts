import type { AuditReport } from '../shared/ipc';

/**
 * Session-scoped audit ledgers backing the in-app audit panel (see the "Verify
 * it yourself" section of the README). Two facts a skeptical reviewer wants to
 * confirm about the running process live here:
 *
 *  - Disk:    how much workspace content has been written to disk, and where.
 *             This only ever increments through the user-initiated export
 *             handlers in ipc.ts; a fresh, idle session reads 0.
 *  - Network: what outbound hosts the SDK client's fetch layer has contacted.
 *             The fetch guard (agent/client.ts) records every request here and
 *             blocks any host other than {@link resolveAllowedHost}.
 *
 * Everything here is self-reported by the app. The README documents how to
 * confirm the same facts independently with OS tooling (strace/lsof/Process
 * Monitor). The ledgers are process-global and last the lifetime of the app.
 */

const disk = {
  writeCount: 0,
  bytesWritten: 0,
  lastPath: null as string | null,
};

/** host -> number of outbound requests observed for that host. */
const networkHosts = new Map<string, number>();
const blockedHosts = new Set<string>();

/**
 * The single host outbound requests are permitted to reach. Defaults to the
 * Anthropic API host; honours ANTHROPIC_BASE_URL (read by the SDK) so a proxied
 * dev setup does not trip the guard. Swapping to Bedrock later means updating
 * only this and agent/client.ts.
 */
export function resolveAllowedHost(): string {
  const base = process.env['ANTHROPIC_BASE_URL'];
  if (base) {
    try {
      return new URL(base).hostname;
    } catch {
      // fall through to the default on a malformed override
    }
  }
  return 'api.anthropic.com';
}

/** Record a user-initiated export of workspace content to disk. */
export function recordExportWrite(path: string, bytes: number): void {
  disk.writeCount += 1;
  disk.bytesWritten += bytes;
  disk.lastPath = path;
}

/**
 * Record an outbound request seen at the fetch layer. Returns whether the host
 * is permitted; the caller (the fetch guard) blocks the request when it is not.
 */
export function recordNetworkRequest(host: string): boolean {
  networkHosts.set(host, (networkHosts.get(host) ?? 0) + 1);
  const allowed = host === resolveAllowedHost();
  if (!allowed) blockedHosts.add(host);
  return allowed;
}

/** The disk and network portions of the report (workspace part is assembled in ipc.ts from the live VFS). */
export function auditLedgerSnapshot(): Pick<AuditReport, 'disk' | 'network'> {
  let requestCount = 0;
  const hosts = [...networkHosts.entries()]
    .map(([host, count]) => {
      requestCount += count;
      return { host, count };
    })
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  return {
    disk: { writeCount: disk.writeCount, bytesWritten: disk.bytesWritten, lastPath: disk.lastPath },
    network: {
      allowedHost: resolveAllowedHost(),
      requestCount,
      hosts,
      blockedHosts: [...blockedHosts].sort(),
    },
  };
}

/**
 * The real fetch to delegate to. Until the guard is installed this dynamically
 * reads `globalThis.fetch` (so tests can spy on it); after install it is the
 * captured original, which breaks the recursion of guarding globalThis.fetch.
 */
const dynamicFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
let realFetch = dynamicFetch;

/**
 * The egress-guarding fetch. Records every outbound request in the ledger and
 * rejects any host other than {@link resolveAllowedHost} before the request
 * leaves the process. Wired into the SDK client explicitly (agent/client.ts)
 * and installed as the main process's `globalThis.fetch` at startup, so any
 * future fetch call in main is covered too — not only the SDK's.
 */
export const guardedFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const rawUrl = input instanceof Request ? input.url : input.toString();
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    host = '<invalid-url>';
  }
  if (!recordNetworkRequest(host)) {
    throw new Error(
      `Blocked outbound request to "${host}": only ${resolveAllowedHost()} is permitted.`,
    );
  }
  return realFetch(input as Parameters<typeof globalThis.fetch>[0], init);
};

/** Replace the main process's global fetch with {@link guardedFetch}. Idempotent. */
export function installProcessFetchGuard(): void {
  if (globalThis.fetch === guardedFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = guardedFetch as typeof globalThis.fetch;
}

/** Test-only: reset both ledgers to their initial state. */
export function __resetAuditForTest(): void {
  disk.writeCount = 0;
  disk.bytesWritten = 0;
  disk.lastPath = null;
  networkHosts.clear();
  blockedHosts.clear();
  realFetch = dynamicFetch;
}
