import { createExtractorRegistry, type ExtractorRegistry, type SearchableTextUnit } from '.';
import type { VirtualWorkspace } from '../workspace/VirtualWorkspace';

export const MAX_INDEX_TEXT_BYTES = 5 * 1024 * 1024;

export interface IndexedDocument {
  path: string;
  units: SearchableTextUnit[];
  skippedReason?: string;
}

interface CacheEntry extends IndexedDocument {
  version: number;
}

const indexes = new WeakMap<VirtualWorkspace, TextIndex>();

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

function textBytes(units: SearchableTextUnit[]): number {
  return units.reduce((sum, unit) => sum + Buffer.byteLength(unit.text, 'utf-8'), 0);
}

export class TextIndex {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly registry: ExtractorRegistry = createExtractorRegistry()) {}

  supports(path: string): boolean {
    const extractor = this.registry.get(extensionOf(path));
    return Boolean(extractor?.extractTextUnits);
  }

  async get(vfs: VirtualWorkspace, path: string): Promise<IndexedDocument> {
    const version = vfs.version(path);
    const cached = this.cache.get(path);
    if (cached && cached.version === version) return cached;

    const extractor = this.registry.get(extensionOf(path));
    if (!extractor?.extractTextUnits) {
      const entry = { path, version, units: [], skippedReason: `No searchable text extractor for "${path}".` };
      this.cache.set(path, entry);
      return entry;
    }

    const units = await extractor.extractTextUnits({ name: path, content: vfs.readBuffer(path) });
    const bytes = textBytes(units);
    const entry: CacheEntry =
      bytes > MAX_INDEX_TEXT_BYTES
        ? {
            path,
            version,
            units: [],
            skippedReason: `"${path}" extracted to ${(bytes / 1024 / 1024).toFixed(
              1,
            )}MB of text, exceeding the ${(MAX_INDEX_TEXT_BYTES / 1024 / 1024).toFixed(
              0,
            )}MB Grep index cap. Use read_document directly with a narrow offset.`,
          }
        : { path, version, units };
    this.cache.set(path, entry);
    return entry;
  }
}

export function textIndexFor(vfs: VirtualWorkspace): TextIndex {
  let index = indexes.get(vfs);
  if (!index) {
    index = new TextIndex();
    indexes.set(vfs, index);
  }
  return index;
}
