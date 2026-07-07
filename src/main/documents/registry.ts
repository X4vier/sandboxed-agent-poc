import type { Extractor } from './types';

/**
 * Maps file extensions to the extractor that handles them. Adding support for a
 * new file type is a single `register()` call — nothing else in the system
 * needs to change.
 */
export class ExtractorRegistry {
  private readonly byExtension = new Map<string, Extractor>();

  register(extractor: Extractor): this {
    for (const ext of extractor.extensions) {
      const key = ext.toLowerCase();
      if (this.byExtension.has(key)) {
        throw new Error(`Duplicate extractor registered for ".${key}"`);
      }
      this.byExtension.set(key, extractor);
    }
    return this;
  }

  get(extension: string): Extractor | undefined {
    return this.byExtension.get(extension.toLowerCase());
  }

  /** Sorted list of supported extensions (without the leading dot). */
  supportedExtensions(): string[] {
    return [...this.byExtension.keys()].sort();
  }
}
