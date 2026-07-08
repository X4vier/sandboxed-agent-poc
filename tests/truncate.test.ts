import { describe, it, expect } from 'vitest';
import { truncateHead, truncateLine, formatSize, DEFAULT_MAX_BYTES } from '../src/main/tools/truncate';

describe('truncateHead', () => {
  it('does not truncate content within both limits', () => {
    const r = truncateHead('a\nb\nc');
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('a\nb\nc');
    expect(r.outputLines).toBe(3);
    expect(r.totalLines).toBe(3);
  });

  it('truncates by line count, keeping whole lines', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const r = truncateHead(content, { maxLines: 4 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('lines');
    expect(r.outputLines).toBe(4);
    expect(r.content).toBe('line1\nline2\nline3\nline4');
  });

  it('truncates by bytes when the byte cap is hit first', () => {
    // 100 lines of 1KB → ~100KB, past the 50KB default byte cap.
    const content = Array.from({ length: 100 }, () => 'x'.repeat(1024)).join('\n');
    const r = truncateHead(content);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('bytes');
    expect(Buffer.byteLength(r.content, 'utf-8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(r.outputLines).toBeLessThan(100);
  });

  it('flags a first line that alone exceeds the byte cap', () => {
    const r = truncateHead('z'.repeat(DEFAULT_MAX_BYTES + 10), { maxBytes: DEFAULT_MAX_BYTES });
    expect(r.firstLineExceedsLimit).toBe(true);
    expect(r.content).toBe('');
    expect(r.outputLines).toBe(0);
  });
});

describe('truncateLine', () => {
  it('leaves short lines intact', () => {
    expect(truncateLine('short', 100)).toEqual({ text: 'short', wasTruncated: false });
  });

  it('caps long lines with a marker', () => {
    const r = truncateLine('a'.repeat(600), 500);
    expect(r.wasTruncated).toBe(true);
    expect(r.text).toContain('line truncated');
    expect(r.text.length).toBeLessThan(600 + 40);
  });
});

describe('formatSize', () => {
  it('renders bytes, KB, and MB', () => {
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(50 * 1024)).toBe('50.0KB');
    expect(formatSize(2 * 1024 * 1024)).toBe('2.0MB');
  });
});
