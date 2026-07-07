import { app } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { StagedFileInfo } from '../../shared/ipc';
import { MAX_FILE_BYTES } from './VirtualWorkspace';

/**
 * The default document corpus that ships with the app (see scripts/seed/). It
 * is pre-staged on launch so the agent starts with a rich, themed set of ~100
 * country documents (half .docx, half .pdf) to operate on — no manual upload
 * required. The files live on disk (bundled via electron-builder
 * `extraResources` in production, or the repo's seed-data/ folder in dev) and
 * are read into the in-memory VFS at task start like any other staged file.
 */

/** Locate the bundled seed-data directory across dev and packaged layouts. */
function seedDir(): string | null {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === 'string') {
    candidates.push(join(process.resourcesPath, 'seed-data')); // packaged (extraResources)
  }

  const electronApp = app as { getAppPath?: () => string } | undefined;
  try {
    const appPath = electronApp?.getAppPath?.();
    if (appPath) {
      candidates.push(
        join(appPath, 'seed-data'), // dev (electron-vite, appPath = repo root)
        join(appPath, '..', 'seed-data'),
      );
    }
  } catch {
    // In plain Node test/script contexts, Electron's app module is unavailable.
  }

  candidates.push(join(process.cwd(), 'seed-data'));
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

/** List the seed corpus as staged-file entries, or [] if none is bundled. */
export function loadSeedCorpus(): StagedFileInfo[] {
  const dir = seedDir();
  if (dir === null) return [];
  try {
    return readdirSync(dir)
      .filter((name) => /\.(pdf|docx)$/i.test(name))
      .map((name) => {
        const path = join(dir, name);
        const size = statSync(path).size;
        return { path, name, size, origin: 'seed' as const };
      })
      .filter((f) => f.size <= MAX_FILE_BYTES)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
