/**
 * A tiny glob matcher over the virtual workspace's POSIX-style keys. No new
 * dependency — patterns are translated to an anchored RegExp. Supports the
 * subset the model reaches for: `*` (within a segment), `?` (one non-slash
 * char), `**` (across segments), and `{a,b}` brace sets.
 */

/** Escape a run of literal text for embedding in a RegExp. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate a glob pattern into an anchored RegExp matched against a whole path. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` crosses path separators. `**/` also matches zero segments so
        // that `**/*.csv` finds `foo.csv` at the root.
        i += 2;
        if (pattern[i] === '/') {
          re += '(?:.*/)?';
          i += 1;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
      } else {
        const options = pattern.slice(i + 1, end).split(',');
        re += `(?:${options.map(escapeLiteral).join('|')})`;
        i = end + 1;
      }
    } else {
      re += escapeLiteral(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Return the keys matching `pattern`, sorted. When `scope` is given, only keys
 * under that directory are considered and the pattern is matched against the
 * path *relative to* the scope (so `*.csv` under `data` finds `data/foo.csv`).
 */
export function matchGlob(keys: string[], pattern: string, scope?: string): string[] {
  const re = globToRegExp(pattern);
  const prefix = scope ? `${scope}/` : '';
  const out: string[] = [];
  for (const key of keys) {
    if (scope) {
      if (!key.startsWith(prefix)) continue;
      if (re.test(key.slice(prefix.length))) out.push(key);
    } else if (re.test(key)) {
      out.push(key);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Does a key satisfy a filename glob filter (as used by Grep's `glob` param)?
 * A slash-free pattern like `*.ts` matches the basename at any depth; a pattern
 * containing `/` is matched against the whole key.
 */
export function matchesGlobFilter(key: string, pattern: string): boolean {
  const re = globToRegExp(pattern);
  if (pattern.includes('/')) return re.test(key);
  const base = key.slice(key.lastIndexOf('/') + 1);
  return re.test(base);
}
