import { ExtractorRegistry } from './registry';
import { pdfExtractor } from './extractors/pdf';

/**
 * Build the registry of document extractors available to the agent. To support
 * a new file type, implement an {@link Extractor} under `extractors/` and add
 * one `.register(...)` call here.
 */
export function createExtractorRegistry(): ExtractorRegistry {
  return new ExtractorRegistry().register(pdfExtractor);
}

export { ExtractorRegistry } from './registry';
export type { Attachment, Extraction, Extractor, SourceFile } from './types';
