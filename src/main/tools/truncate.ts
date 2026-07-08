/**
 * Shared truncation utilities for tool outputs, modeled on Pi's
 * `core/tools/truncate.ts`. Truncation is governed by two independent limits —
 * whichever is hit first wins:
 * - a line limit (default 2000 lines)
 * - a byte limit (default 50KB)
 *
 * `truncateHead` never returns partial lines: if the very first line already
 * exceeds the byte limit it returns empty content with `firstLineExceedsLimit`
 * set, so callers can emit an explicit notice. `truncateLine` caps a single line
 * (used for Grep match lines).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per Grep match line

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncationResult {
  /** The truncated content (complete lines only). */
  content: string;
  /** Whether truncation occurred. */
  truncated: boolean;
  /** Which limit was hit, or null if not truncated. */
  truncatedBy: 'lines' | 'bytes' | null;
  /** Total number of lines in the original content. */
  totalLines: number;
  /** Number of complete lines in the truncated output. */
  outputLines: number;
  /** Whether the first line alone exceeded the byte limit (nothing was kept). */
  firstLineExceedsLimit: boolean;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** Format a byte count as a short human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Keep the first N lines / bytes of `content` (whichever limit hits first),
 * returning only complete lines. Suitable for file reads.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, 'utf-8');

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, firstLineExceedsLimit: false };
  }

  // A single opening line that can't fit the byte budget: keep nothing, flag it.
  if (lines.length > 0 && Buffer.byteLength(lines[0], 'utf-8') > maxBytes) {
    return { content: '', truncated: true, truncatedBy: 'bytes', totalLines, outputLines: 0, firstLineExceedsLimit: true };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (i > 0 ? 1 : 0); // +1 for the newline
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    kept.push(lines[i]);
    bytes += lineBytes;
  }
  if (kept.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines';

  return {
    content: kept.join('\n'),
    truncated: true,
    truncatedBy,
    totalLines,
    outputLines: kept.length,
    firstLineExceedsLimit: false,
  };
}

/** Cap a single line to `maxChars`, appending a marker when truncated. */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}… [line truncated]`, wasTruncated: true };
}
