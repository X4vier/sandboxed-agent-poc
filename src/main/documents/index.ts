import { ExtractorRegistry } from './registry';
import { pdfExtractor } from './extractors/pdf';
import { docxExtractor } from './extractors/docx';

/**
 * Build the registry of document extractors available to the agent. To support
 * a new file type, implement an {@link Extractor} under `extractors/` and add
 * one `.register(...)` call here.
 */
export function createExtractorRegistry(): ExtractorRegistry {
  return new ExtractorRegistry().register(pdfExtractor).register(docxExtractor);
}

export { ExtractorRegistry } from './registry';
export type { Attachment, Extraction, Extractor, ReadWindow, SourceFile } from './types';
