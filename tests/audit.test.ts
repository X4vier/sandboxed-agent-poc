import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAuditForTest,
  auditLedgerSnapshot,
  guardedFetch,
  installProcessFetchGuard,
  recordExportWrite,
  recordNetworkRequest,
  resolveAllowedHost,
} from '../src/main/audit';

afterEach(() => {
  __resetAuditForTest();
  delete process.env['ANTHROPIC_BASE_URL'];
  vi.restoreAllMocks();
});

describe('audit ledger', () => {
  it('starts empty', () => {
    const snap = auditLedgerSnapshot();
    expect(snap.disk).toEqual({ writeCount: 0, bytesWritten: 0, lastPath: null });
    expect(snap.network.requestCount).toBe(0);
    expect(snap.network.hosts).toEqual([]);
    expect(snap.network.blockedHosts).toEqual([]);
    expect(snap.network.allowedHost).toBe('api.anthropic.com');
  });

  it('accumulates export writes and remembers the last path', () => {
    recordExportWrite('/home/u/out/a.txt', 100);
    recordExportWrite('/home/u/out/b.txt', 25);
    expect(auditLedgerSnapshot().disk).toEqual({
      writeCount: 2,
      bytesWritten: 125,
      lastPath: '/home/u/out/b.txt',
    });
  });

  it('permits the allowed host and tallies requests per host', () => {
    expect(recordNetworkRequest('api.anthropic.com')).toBe(true);
    expect(recordNetworkRequest('api.anthropic.com')).toBe(true);
    const { network } = auditLedgerSnapshot();
    expect(network.requestCount).toBe(2);
    expect(network.hosts).toEqual([{ host: 'api.anthropic.com', count: 2 }]);
    expect(network.blockedHosts).toEqual([]);
  });

  it('blocks and records any other host', () => {
    expect(recordNetworkRequest('evil.example.com')).toBe(false);
    expect(recordNetworkRequest('169.254.169.254')).toBe(false);
    const { network } = auditLedgerSnapshot();
    expect(network.blockedHosts).toEqual(['169.254.169.254', 'evil.example.com']);
    // Blocked attempts are still counted so a reviewer sees the attempt happened.
    expect(network.requestCount).toBe(2);
  });

  it('honours ANTHROPIC_BASE_URL for the allowed host', () => {
    process.env['ANTHROPIC_BASE_URL'] = 'https://proxy.internal:8443/anthropic';
    expect(resolveAllowedHost()).toBe('proxy.internal');
    expect(recordNetworkRequest('proxy.internal')).toBe(true);
    expect(recordNetworkRequest('api.anthropic.com')).toBe(false);
  });

  it('falls back to the default host when ANTHROPIC_BASE_URL is malformed', () => {
    process.env['ANTHROPIC_BASE_URL'] = 'not a url';
    expect(resolveAllowedHost()).toBe('api.anthropic.com');
  });
});

describe('guardedFetch egress guard', () => {
  it('forwards requests to the allowed host and records them', async () => {
    const underlying = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await guardedFetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(underlying).toHaveBeenCalledOnce();
    expect(auditLedgerSnapshot().network.requestCount).toBe(1);
  });

  it('blocks a disallowed host before any network call is made', async () => {
    const underlying = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope'));

    await expect(guardedFetch('https://evil.example.com/steal')).rejects.toThrow(
      /Blocked outbound request/,
    );
    expect(underlying).not.toHaveBeenCalled();
    expect(auditLedgerSnapshot().network.blockedHosts).toEqual(['evil.example.com']);
  });

  it('resolves the host from a Request object input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await guardedFetch(new Request('https://api.anthropic.com/v1/models'));
    expect(auditLedgerSnapshot().network.hosts).toEqual([
      { host: 'api.anthropic.com', count: 1 },
    ]);
  });
});

describe('installProcessFetchGuard', () => {
  it('replaces globalThis.fetch and still blocks disallowed hosts without recursing', async () => {
    const original = globalThis.fetch;
    const underlying = vi.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = underlying as typeof globalThis.fetch;
    try {
      installProcessFetchGuard();
      expect(globalThis.fetch).toBe(guardedFetch);
      // Idempotent: a second install must not capture the guard as "real fetch".
      installProcessFetchGuard();

      const res = await globalThis.fetch('https://api.anthropic.com/v1/messages');
      expect(res.status).toBe(200);
      expect(underlying).toHaveBeenCalledOnce();

      await expect(globalThis.fetch('https://evil.example.com/x')).rejects.toThrow(
        /Blocked outbound request/,
      );
      expect(underlying).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
