import { PDFDocument } from 'pdf-lib';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Extraction, Extractor, ReadWindow, SearchableTextUnit, SourceFile } from '../types';

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
type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

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
  async extractTextUnits(file: SourceFile): Promise<SearchableTextUnit[]> {
    if (file.content.length > MAX_SOURCE_BYTES) return [];
    let task: ReturnType<PdfJsModule['getDocument']> | undefined;
    try {
      const { getDocument, VerbosityLevel } = await loadPdfJs();
      task = getDocument({
        data: new Uint8Array(file.content),
        useWorkerFetch: false,
        verbosity: VerbosityLevel.ERRORS,
      });
      const document = await task.promise;
      const units: SearchableTextUnit[] = [];
      try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          const page = await document.getPage(pageNumber);
          try {
            units.push({
              label: 'page',
              index: pageNumber,
              text: textContentToLines((await page.getTextContent()).items),
            });
          } finally {
            page.cleanup();
          }
        }
      } finally {
        await document.cleanup();
      }
      return units;
    } catch {
      return [];
    } finally {
      await task?.destroy().catch(() => undefined);
    }
  },
};

async function loadPdfJs(): Promise<PdfJsModule> {
  installPdfJsDomPolyfills();
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

// PDF.js probes optional canvas rendering support at import time. Grep only uses
// getTextContent(), so these minimal fallbacks keep text extraction working when
// @napi-rs/canvas is absent without pretending to support rendering.
function installPdfJsDomPolyfills(): void {
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = MinimalDOMMatrix as unknown as typeof DOMMatrix;
  if (!globalThis.Path2D) globalThis.Path2D = MinimalPath2D as unknown as typeof Path2D;
}

function textContentToLines(items: Array<TextItem | { type: string }>): string {
  const lines: string[] = [];
  let current = '';
  let lastY: number | undefined;
  const flush = (): void => {
    const line = current.trim();
    if (line.length > 0) lines.push(line);
    current = '';
  };

  for (const item of items) {
    if (!('str' in item)) continue;
    const y = typeof item.transform[5] === 'number' ? item.transform[5] : undefined;
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2) flush();
    if (item.str.length > 0) {
      if (current.length > 0 && !/\s$/.test(current) && !/^\s/.test(item.str)) current += ' ';
      current += item.str;
    }
    if (item.hasEOL) flush();
    if (y !== undefined) lastY = y;
  }
  flush();
  return lines.join('\n');
}

class MinimalDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m11 = 1;
  m12 = 0;
  m21 = 0;
  m22 = 1;
  m41 = 0;
  m42 = 0;

  constructor(init?: string | number[]) {
    if (Array.isArray(init)) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      this.syncAliases();
    }
  }

  multiplySelf(): this {
    return this;
  }

  preMultiplySelf(): this {
    return this;
  }

  translateSelf(): this {
    return this;
  }

  scaleSelf(): this {
    return this;
  }

  rotateSelf(): this {
    return this;
  }

  invertSelf(): this {
    return this;
  }

  translate(): this {
    return this;
  }

  scale(): this {
    return this;
  }

  transformPoint(point?: DOMPointInit): DOMPoint {
    return { x: point?.x ?? 0, y: point?.y ?? 0, z: point?.z ?? 0, w: point?.w ?? 1 } as DOMPoint;
  }

  private syncAliases(): void {
    this.m11 = this.a;
    this.m12 = this.b;
    this.m21 = this.c;
    this.m22 = this.d;
    this.m41 = this.e;
    this.m42 = this.f;
  }
}

class MinimalPath2D {
  addPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  rect(): void {}
  roundRect(): void {}
  arc(): void {}
  arcTo(): void {}
  ellipse(): void {}
}
