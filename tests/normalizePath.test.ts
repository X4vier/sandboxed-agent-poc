import { describe, it, expect } from 'vitest';
import {
  normalizeWorkspacePath,
  sanitizeExportFilename,
  WorkspacePathError,
} from '../src/main/workspace/normalizePath';

describe('normalizeWorkspacePath — valid paths', () => {
  const cases: Array<[string, string]> = [
    ['data/input.csv', 'data/input.csv'],
    ['a/./b', 'a/b'],
    ['a//b', 'a/b'],
    ['a/b/', 'a/b'],
    ['./a', 'a'],
    ['a/b/../c', 'a/c'],
    ['a/b/../../a', 'a'],
    ['file.txt', 'file.txt'],
    ['deep/nested/dir/file.md', 'deep/nested/dir/file.md'],
    ['a\\b\\c', 'a/b/c'], // backslashes are normalized, not rejected, when relative
    ['COM10.txt', 'COM10.txt'], // only COM1-9 are reserved
    ['console.txt', 'console.txt'], // not a device name
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeWorkspacePath(input)).toBe(expected);
    });
  }
});

describe('normalizeWorkspacePath — round-trip stability', () => {
  const paths = ['data/input.csv', 'a/b/c', 'x.txt', 'deep/nested/file.md'];
  for (const p of paths) {
    it(`normalizing ${JSON.stringify(p)} twice is a no-op`, () => {
      const once = normalizeWorkspacePath(p);
      expect(normalizeWorkspacePath(once)).toBe(once);
    });
  }
});

describe('normalizeWorkspacePath — rejected paths', () => {
  const rejected: string[] = [
    // escaping
    '../a',
    'a/../../b',
    '..',
    '../../etc/passwd',
    '..\\..\\x',
    'a/b/../../../c',
    // absolute POSIX
    '/x',
    '/etc/passwd',
    // absolute Windows drive
    'C:\\x',
    'C:/x',
    'C:x',
    'c:\\Windows\\win.ini',
    // UNC
    '\\\\server\\share',
    '//server/share',
    '//x',
    // null byte
    'a\0b',
    'file\0.txt',
    // device names (with and without extension)
    'CON',
    'con',
    'PRN.txt',
    'aux',
    'NUL',
    'COM1',
    'com9.log',
    'LPT1',
    'lpt9.dat',
    'NUL.tar.gz',
    // ADS / stream forms
    'file.txt:ads',
    'a/secret:stream',
    // empty / degenerate
    '',
    '.',
    './',
    'a/..',
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => normalizeWorkspacePath(input)).toThrow(WorkspacePathError);
    });
  }
});

describe('sanitizeExportFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeExportFilename('a/b/report.md')).toBe('report.md');
    expect(sanitizeExportFilename('..\\..\\evil.txt')).toBe('evil.txt');
  });
  it('replaces illegal characters but keeps spaces and hyphens', () => {
    expect(sanitizeExportFilename('my report-v2.txt')).toBe('my report-v2.txt');
    expect(sanitizeExportFilename('a:b?c*.txt')).toBe('a_b_c_.txt');
  });
  it('never returns a device name', () => {
    expect(sanitizeExportFilename('CON')).toBe('export_CON');
    expect(sanitizeExportFilename('nul.txt')).not.toBe('nul.txt');
  });
  it('never returns empty', () => {
    expect(sanitizeExportFilename('').length).toBeGreaterThan(0);
    expect(sanitizeExportFilename('...').length).toBeGreaterThan(0);
  });
});
