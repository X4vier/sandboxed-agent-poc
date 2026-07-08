import type { AgentBridge, AuditReport } from '../shared/ipc';
import type { Toast } from './dom';
import { el, errorMessage, fmtBytes } from './dom';

interface AuditElements {
  auditEl: HTMLElement;
  auditBody: HTMLElement;
  openBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
}

export interface AuditView {
  /** Refresh the report if the panel is currently open (cheap no-op otherwise). */
  refreshIfOpen(): void;
}

type Tone = 'ok' | 'warn' | 'alert';

/** A titled section with a status dot summarising its tone. */
function section(tone: Tone, title: string, note: string): HTMLElement {
  const sec = el('div', `audit-section ${tone}`);
  const head = el('div', 'audit-section-head');
  head.append(el('span', 'audit-dot'), el('span', 'audit-section-title', title));
  sec.append(head, el('div', 'audit-note', note));
  return sec;
}

function metric(sec: HTMLElement, label: string, value: string, tone?: Tone): void {
  const row = el('div', `audit-metric${tone ? ` ${tone}` : ''}`);
  row.append(el('span', 'audit-metric-label', label), el('span', 'audit-metric-value', value));
  sec.append(row);
}

function render(body: HTMLElement, report: AuditReport): void {
  body.replaceChildren();
  const { workspace, disk, network, debugLog, apiKey } = report;

  // --- Files in RAM -------------------------------------------------------
  const ws = section(
    'ok',
    'Files in memory',
    workspace.active
      ? 'Agent-visible file content exists only here, in the in-RAM workspace. Closing the app discards it — there is nothing on disk to wipe.'
      : 'No workspace yet — it is built in RAM when you run a task, and never touches disk.',
  );
  metric(ws, 'Files held in RAM', String(workspace.fileCount));
  metric(
    ws,
    'Total in memory',
    `${fmtBytes(workspace.totalBytes)} / ${fmtBytes(workspace.maxTotalBytes)} cap`,
  );
  for (const status of ['provided', 'created', 'modified'] as const) {
    const s = workspace.byStatus[status];
    if (s.count > 0) metric(ws, `· ${status}`, `${s.count} file(s), ${fmtBytes(s.bytes)}`);
  }
  body.append(ws);

  // --- Disk writes --------------------------------------------------------
  const noWrites = disk.writeCount === 0;
  const dsk = section(
    debugLog.active ? 'alert' : noWrites ? 'ok' : 'warn',
    'Workspace content written to disk',
    debugLog.active
      ? 'Debug logging (AGENT_DEBUG_LOG) is ON: agent events and tool inputs are being written to disk in addition to any exports below. The no-disk-residue guarantee does NOT hold this session.'
      : noWrites
        ? 'Zero. The only code paths that write workspace content to disk are the Save buttons — and you have not used them this session.'
        : 'These bytes were written by your own Save / Export actions. The agent cannot write to disk on its own.',
  );
  if (debugLog.active) {
    metric(dsk, 'Debug log', debugLog.fileName ?? 'active (no file yet)', 'alert');
  }
  metric(dsk, 'Export writes this session', String(disk.writeCount), noWrites ? 'ok' : 'warn');
  if (!noWrites) {
    metric(dsk, 'Bytes exported', fmtBytes(disk.bytesWritten));
    if (disk.lastPath) metric(dsk, 'Last export', disk.lastPath);
  }
  body.append(dsk);

  // --- Network egress -----------------------------------------------------
  const blocked = network.blockedHosts.length > 0;
  const net = section(
    blocked ? 'alert' : 'ok',
    'Outbound network',
    blocked
      ? 'A request to a non-allowed host was attempted and blocked by an egress guard.'
      : `Requests are checked at two layers — every main-process fetch and the browser network stack; only ${network.allowedHost} is permitted. Raw OS sockets are outside this self-report; see “Verify it yourself” in the README.`,
  );
  metric(net, 'Allowed host', network.allowedHost);
  metric(net, 'Requests this session', String(network.requestCount));
  for (const h of network.hosts) {
    metric(net, `· ${h.host}`, `${h.count} request(s)`, h.host === network.allowedHost ? undefined : 'alert');
  }
  if (blocked) metric(net, 'Blocked hosts', network.blockedHosts.join(', '), 'alert');
  body.append(net);

  // --- API key ------------------------------------------------------------
  const key = section(
    'ok',
    'API key',
    'The key lives only in a main-process variable. It is never written to disk, never returned to this window, and is gone when the app exits.',
  );
  metric(key, 'Key set for this session', apiKey.present ? 'yes (in memory only)' : 'no');
  body.append(key);
}

export function createAuditView(agent: AgentBridge, elements: AuditElements, toast: Toast): AuditView {
  const { auditEl, auditBody, openBtn, closeBtn } = elements;
  let open = false;
  let timer: number | undefined;

  async function refresh(): Promise<void> {
    try {
      render(auditBody, await agent.auditReport());
    } catch (err) {
      toast.show(errorMessage(err), true);
    }
  }

  function close(): void {
    open = false;
    auditEl.hidden = true;
    window.clearInterval(timer);
    timer = undefined;
  }

  async function openPanel(): Promise<void> {
    open = true;
    auditEl.hidden = false;
    await refresh();
    // Poll while open so counters (requests, exports) update as the user works.
    window.clearInterval(timer);
    timer = window.setInterval(() => void refresh(), 1000);
  }

  openBtn.addEventListener('click', () => void openPanel());
  closeBtn.addEventListener('click', close);
  auditEl.addEventListener('click', (e) => {
    if (e.target === auditEl) close(); // click the backdrop to dismiss
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) close();
  });

  return {
    refreshIfOpen(): void {
      if (open) void refresh();
    },
  };
}
