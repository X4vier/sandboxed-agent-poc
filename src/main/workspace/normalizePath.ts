/**
 * Security-critical path validator for the virtual workspace.
 *
 * There is no real filesystem to resolve against — the VFS is a Map keyed by
 * canonical POSIX-relative paths. Normalization is therefore purely string-level:
 * we collapse `.`/`..`/redundant separators logically and reject anything that
 * could escape the root or, once exported, name a dangerous file on Windows.
 *
 * Used by every VFS operation and every guest-injected file function.
 */

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/** Windows reserved device names (case-insensitive), with or without extension. */
const WINDOWS_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function isWindowsDeviceName(segment: string): boolean {
  // Windows resolves a device regardless of extension: `CON`, `CON.txt`,
  // `NUL.tar.gz` all refer to the device. The base is the text before the
  // first dot.
  const dot = segment.indexOf('.');
  const base = (dot === -1 ? segment : segment.slice(0, dot)).toUpperCase();
  return WINDOWS_DEVICE_NAMES.has(base);
}

/** Returns the canonical VFS key, or throws WorkspacePathError. */
export function normalizeWorkspacePath(userPath: string): string {
  if (typeof userPath !== 'string') {
    throw new WorkspacePathError('Path must be a string.');
  }
  if (userPath.length === 0) {
    throw new WorkspacePathError('Path is empty.');
  }
  if (userPath.includes('\0')) {
    throw new WorkspacePathError('Path contains a null byte.');
  }

  // Reject Windows drive-letter forms (C:\x, C:/x, C:x) before any transform.
  if (/^[a-zA-Z]:/.test(userPath)) {
    throw new WorkspacePathError(`Absolute (drive) paths are not allowed: "${userPath}"`);
  }

  // Unify separators so backslash-mixed and UNC forms collapse to POSIX.
  const unified = userPath.replace(/\\/g, '/');

  // Any leading slash means absolute (/x) or UNC (//server/share).
  if (unified.startsWith('/')) {
    throw new WorkspacePathError(`Absolute paths are not allowed: "${userPath}"`);
  }

  const out: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) {
        throw new WorkspacePathError(`Path escapes the workspace root: "${userPath}"`);
      }
      out.pop();
      continue;
    }
    // A colon in a segment is either a drive letter or an NTFS
    // alternate-data-stream form (file.txt:stream) — both forbidden.
    if (seg.includes(':')) {
      throw new WorkspacePathError(`Path segment contains a colon: "${seg}"`);
    }
    if (isWindowsDeviceName(seg)) {
      throw new WorkspacePathError(`Path segment is a reserved Windows device name: "${seg}"`);
    }
    out.push(seg);
  }

  if (out.length === 0) {
    throw new WorkspacePathError(`Path normalizes to empty: "${userPath}"`);
  }

  return out.join('/');
}

/**
 * Sanitize a suggested filename (basename) for the OS save dialog. Strips any
 * directory components and forbidden characters so an export can never write a
 * path the user did not choose. Returns a safe, non-empty basename.
 */
export function sanitizeExportFilename(name: string): string {
  // Take the last path-ish segment only.
  const parts = name.replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1] ?? '';
  // Replace characters illegal in Windows filenames with underscore
  // (the reserved set <>:"/\|?* — spaces and hyphens are left intact).
  let cleaned = base.replace(/[<>:"/\\|?*]/g, '_');
  // Strip trailing dots/spaces (Windows silently drops them).
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (cleaned.length === 0 || isWindowsDeviceName(cleaned)) {
    cleaned = `export_${cleaned.length > 0 ? cleaned : 'file'}`;
  }
  return cleaned;
}
