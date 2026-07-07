import { describe, it, expect } from 'vitest';
import { globToRegExp, matchGlob, matchesGlobFilter } from '../src/main/tools/glob';

describe('globToRegExp', () => {
  it('* matches within a segment but not across slashes', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(false);
  });

  it('** matches across segments', () => {
    const re = globToRegExp('**/*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/nested/a.ts')).toBe(true);
    expect(re.test('a.md')).toBe(false);
  });

  it('? matches exactly one non-slash character', () => {
    const re = globToRegExp('a?.txt');
    expect(re.test('ab.txt')).toBe(true);
    expect(re.test('a.txt')).toBe(false);
    expect(re.test('a/.txt')).toBe(false);
  });

  it('{a,b} brace sets match any option', () => {
    const re = globToRegExp('*.{ts,tsx}');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('a.tsx')).toBe(true);
    expect(re.test('a.js')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    const re = globToRegExp('a.b+c.txt');
    expect(re.test('a.b+c.txt')).toBe(true);
    expect(re.test('aXbXcXtxt')).toBe(false);
  });
});

describe('matchGlob', () => {
  const keys = ['a.csv', 'data/b.csv', 'data/nested/c.csv', 'data/d.txt', 'other/e.csv'];

  it('matches extension patterns across directories with **', () => {
    expect(matchGlob(keys, '**/*.csv')).toEqual([
      'a.csv',
      'data/b.csv',
      'data/nested/c.csv',
      'other/e.csv',
    ]);
  });

  it('matches only the root with a bare *', () => {
    expect(matchGlob(keys, '*.csv')).toEqual(['a.csv']);
  });

  it('scopes matching relative to a directory', () => {
    expect(matchGlob(keys, '*.csv', 'data')).toEqual(['data/b.csv']);
    expect(matchGlob(keys, '**/*.csv', 'data')).toEqual(['data/b.csv', 'data/nested/c.csv']);
  });

  it('returns nothing when no keys match', () => {
    expect(matchGlob(keys, '*.md')).toEqual([]);
  });
});

describe('matchesGlobFilter', () => {
  it('slash-free patterns match the basename at any depth', () => {
    expect(matchesGlobFilter('src/deep/a.ts', '*.ts')).toBe(true);
    expect(matchesGlobFilter('a.md', '*.ts')).toBe(false);
  });

  it('patterns with a slash match the whole key', () => {
    expect(matchesGlobFilter('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlobFilter('lib/a.ts', 'src/*.ts')).toBe(false);
  });
});
