import type { FileStatus, WorkspaceFileInfo } from '../../shared/ipc';
import { normalizeWorkspacePath, sanitizeExportFilename } from './normalizePath';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // ~50MB per file
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // ~500MB total

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

interface VfsEntry {
  content: Buffer;
  status: FileStatus;
}

/**
 * In-memory virtual filesystem for a single task. Content never touches disk;
 * discarding the instance is the only cleanup required. Every path is validated
 * through {@link normalizeWorkspacePath} before it becomes a key.
 */
export class VirtualWorkspace {
  private readonly files = new Map<string, VfsEntry>();

  get fileCount(): number {
    return this.files.size;
  }

  get totalBytes(): number {
    let total = 0;
    for (const entry of this.files.values()) total += entry.content.length;
    return total;
  }

  private ensureWithinCaps(incomingSize: number, replacingKey: string | null): void {
    if (incomingSize > MAX_FILE_BYTES) {
      throw new WorkspaceError(
        `File is ${mb(incomingSize)}, exceeding the ${mb(MAX_FILE_BYTES)} per-file limit.`,
      );
    }
    const replaced = replacingKey ? (this.files.get(replacingKey)?.content.length ?? 0) : 0;
    const projected = this.totalBytes - replaced + incomingSize;
    if (projected > MAX_TOTAL_BYTES) {
      throw new WorkspaceError(
        `Adding this file would bring the workspace to ${mb(projected)}, exceeding the ${mb(
          MAX_TOTAL_BYTES,
        )} total limit.`,
      );
    }
  }

  /** Derive a safe single-segment key from an on-disk basename. */
  private safeKeyFromName(name: string): string {
    const parts = name.replace(/\\/g, '/').split('/');
    const base = parts[parts.length - 1] || 'file';
    try {
      return normalizeWorkspacePath(base);
    } catch {
      return sanitizeExportFilename(base);
    }
  }

  private disambiguate(key: string): string {
    if (!this.files.has(key)) return key;
    const dot = key.lastIndexOf('.');
    const stem = dot > 0 ? key.slice(0, dot) : key;
    const ext = dot > 0 ? key.slice(dot) : '';
    let i = 1;
    let candidate = `${stem}-${i}${ext}`;
    while (this.files.has(candidate)) {
      i += 1;
      candidate = `${stem}-${i}${ext}`;
    }
    return candidate;
  }

  /**
   * Stage a user-provided file read from disk. Returns the VFS key actually
   * used (basename collisions are disambiguated with a numeric suffix).
   */
  stageProvided(originalName: string, content: Buffer): string {
    this.ensureWithinCaps(content.length, null);
    const key = this.disambiguate(this.safeKeyFromName(originalName));
    this.files.set(key, { content, status: 'provided' });
    return key;
  }

  has(path: string): boolean {
    return this.files.has(normalizeWorkspacePath(path));
  }

  /** Raw bytes for a file, or throw if missing. */
  readBuffer(path: string): Buffer {
    const key = normalizeWorkspacePath(path);
    const entry = this.files.get(key);
    if (!entry) throw new WorkspaceError(`No such file: "${key}"`);
    return entry.content;
  }

  /**
   * Decode a file as UTF-8. Returns `{ ok: false }` if the bytes are not valid
   * UTF-8 rather than returning mojibake.
   */
  readText(path: string): { ok: true; text: string } | { ok: false; size: number } {
    const buf = this.readBuffer(path);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { ok: true, text };
    } catch {
      return { ok: false, size: buf.length };
    }
  }

  /** Create or overwrite a file. Tracks provided/created/modified status. */
  writeFile(path: string, content: string | Buffer): string {
    const key = normalizeWorkspacePath(path);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const existing = this.files.get(key);
    this.ensureWithinCaps(buf.length, existing ? key : null);
    let status: FileStatus;
    if (!existing) status = 'created';
    else if (existing.status === 'created') status = 'created';
    else status = 'modified';
    this.files.set(key, { content: buf, status });
    return key;
  }

  status(path: string): FileStatus {
    const key = normalizeWorkspacePath(path);
    const entry = this.files.get(key);
    if (!entry) throw new WorkspaceError(`No such file: "${key}"`);
    return entry.status;
  }

  /** All files, sorted by path. */
  list(): WorkspaceFileInfo[] {
    return [...this.files.entries()]
      .map(([path, entry]) => ({ path, size: entry.content.length, status: entry.status }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Iterate keys (already-normalized) for tools that scan the VFS. */
  keys(): string[] {
    return [...this.files.keys()].sort((a, b) => a.localeCompare(b));
  }
}
