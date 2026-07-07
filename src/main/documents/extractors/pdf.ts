import { PDFDocument } from 'pdf-lib';
import type { Extraction, Extractor, ReadWindow, SourceFile } from '../types';

/**
 * PDF reading, mirroring Claude Code: rather than scraping a text layer (which
 * fails on scanned or unusually-encoded PDFs), we hand the pages to the
 * Anthropic document pipeline, which reads both text and visuals. Reads are
 * bounded by PAGE range so an arbitrary user PDF never enters the context
 * whole — offset/limit are 1-indexed page numbers, capped per call.
 */

// base64 inflates ~33%; keep the attached slice well under the ~32MB request cap.
const MAX_ATTACH_BYTES = 16 * 1024 * 1024;
// Loading a pathological source into memory: refuse politely past this.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PDF_PAGES = 10; // pages per call when the caller gives no limit
export const MAX_PDF_PAGES = 20; // hard cap per call, mirroring Claude Code

export const pdfExtractor: Extractor = {
  extensions: ['pdf'],
  label: 'PDF',
  async extract(file: SourceFile, window: ReadWindow): Promise<Extraction> {
    if (file.content.length > MAX_SOURCE_BYTES) {
      return {
        text: `"${file.name}" is ${(file.content.length / 1024 / 1024).toFixed(1)}MB, too large to read. Ask for a smaller PDF.`,
      };
    }

    let source: PDFDocument;
    try {
      source = await PDFDocument.load(file.content, { ignoreEncryption: true });
    } catch (e) {
      return { text: `Could not open "${file.name}" as a PDF: ${(e as Error).message}` };
    }

    const total = source.getPageCount();
    if (total === 0) return { text: `"${file.name}" has no pages.` };

    const start = Math.max(1, window.offset);
    if (start > total) {
      return { text: `offset ${start} is past the end of "${file.name}", which has ${total} page(s).` };
    }

    const limit = Math.min(Math.max(1, window.limit ?? DEFAULT_PDF_PAGES), MAX_PDF_PAGES);
    const end = Math.min(total, start + limit - 1);

    const slice = await PDFDocument.create();
    const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
    const copied = await slice.copyPages(source, indices);
    for (const page of copied) slice.addPage(page);
    const bytes = await slice.save();

    if (bytes.length > MAX_ATTACH_BYTES) {
      return {
        text: `Pages ${start}-${end} of "${file.name}" are too large to attach (${(bytes.length / 1024 / 1024).toFixed(1)}MB). Request fewer pages with a smaller limit.`,
      };
    }

    const scope = total === 1 ? 'the only page' : `pages ${start}-${end} of ${total}`;
    const more =
      end < total ? ` Re-call with offset=${end + 1} to read the next pages.` : '';
    return {
      text: `Attached ${scope} of "${file.name}" for reading.${more}`,
      attachments: [
        { kind: 'document', mediaType: 'application/pdf', data: Buffer.from(bytes).toString('base64') },
      ],
    };
  },
};
