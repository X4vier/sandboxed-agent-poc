/**
 * Document extraction contracts. An {@link Extractor} converts one file type's
 * raw bytes into model-readable content: plain text (returned inline in a tool
 * result) and/or attachments (image / PDF content blocks sent to the model).
 *
 * Extractors are pure and dependency-free — they touch neither the Anthropic
 * SDK nor the workspace, which keeps them trivially unit-testable. The mapping
 * from {@link Attachment} to an SDK content block lives in the tool layer
 * (see tools/documentTools.ts).
 */

/** A file handed to an extractor: its workspace name plus raw bytes. */
export interface SourceFile {
  name: string;
  content: Buffer;
}

/** Rich (non-text) content an extractor wants surfaced to the model. */
export type Attachment =
  | {
      kind: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      /** Base64-encoded bytes (no newlines). */
      data: string;
    }
  | {
      kind: 'document';
      mediaType: 'application/pdf';
      /** Base64-encoded bytes (no newlines). */
      data: string;
    };

/** What an extractor produces from a file. */
export interface Extraction {
  /** Text placed directly into the tool result (may be empty). */
  text: string;
  /** Media blocks to attach to the conversation (images, native PDF, …). */
  attachments?: Attachment[];
}

/** Turns a supported file type into model-consumable content. */
export interface Extractor {
  /** Lower-case extensions handled, e.g. `['pdf']`. */
  readonly extensions: readonly string[];
  /** Short human label used in messages, e.g. `'PDF'`. */
  readonly label: string;
  extract(file: SourceFile): Extraction | Promise<Extraction>;
}
