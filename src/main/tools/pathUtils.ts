/**
 * Small path helpers shared across the file tools: "did you mean …?" suggestions
 * for a missing key (Read/Edit) and a directory-prefix test (list_files/Grep).
 */

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = tmp;
    }
  }
  return row[n];
}

/** "Did you mean …?" suffix for a missing key, using the closest existing keys. */
export function suggestKeys(target: string, keys: string[]): string {
  if (keys.length === 0) return '';
  const threshold = Math.max(3, Math.floor(target.length / 2));
  const near = keys
    .map((k) => ({ k, d: levenshtein(target, k) }))
    .filter((s) => s.d <= threshold)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((s) => s.k);
  return near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '';
}

export function missingFile(key: string, ctx: { vfs: { keys(): string[] } }): string {
  return `File does not exist: "${key}".${suggestKeys(key, ctx.vfs.keys())}`;
}

/** Is `key` at, or under, the given directory prefix? A missing prefix matches all. */
export function underPath(key: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  return key === prefix || key.startsWith(`${prefix}/`);
}
