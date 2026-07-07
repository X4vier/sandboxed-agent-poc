import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { AgentTool } from '../agent/types';
import type { Attachment, ExtractorRegistry } from '../documents';
import { getOptionalInteger, getString } from './inputs';

/** The one place document extraction touches the Anthropic SDK's block shape. */
function toContentBlock(attachment: Attachment): ContentBlockParam {
  if (attachment.kind === 'image') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
    };
  }
  return {
    type: 'document',
    source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
  };
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

/**
 * A single tool that reads any registered document type, dispatching by
 * extension and passing a bounded {@link ReadWindow}. An extractor returns
 * text (returned inline) and/or attachments — PDF pages, images — which are
 * surfaced to the model via {@link ToolContext.attachBlocks}.
 */
export function createReadDocumentTool(registry: ExtractorRegistry): AgentTool {
  const supported = registry
    .supportedExtensions()
    .map((e) => `.${e}`)
    .join(', ');
  return {
    name: 'read_document',
    description:
      'Read a non-plain-text document from the workspace. Input: { "path": "<workspace-relative ' +
      'path>", "offset"?: <1-indexed start>, "limit"?: <max units> }. ' +
      `Supported types: ${supported}. Reads are BOUNDED so a large file never enters context whole: ` +
      'the unit is pages for PDFs (attached for you to read visually; default 10, max 20 per call) ' +
      'and lines for text-based documents (default 2000). When more remains, the result tells you ' +
      'the offset to resume from. To find something specific in a big document, prefer Grep over ' +
      'paging through it all. Use Read for plain text (.txt, .md, source).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path.' },
        offset: {
          type: 'number',
          description: '1-indexed unit to start at — page for PDFs, line for text documents.',
        },
        limit: {
          type: 'number',
          description: 'Max units to read: pages for PDFs (max 20), lines for text documents.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (input, ctx) => {
      const key = ctx.normalizePath(getString(input, 'path'));
      const ext = extensionOf(key);
      const extractor = registry.get(ext);
      if (!extractor) {
        return `No reader for ".${ext}" files. Supported document types: ${supported}. For plain text, use Read.`;
      }
      const content = ctx.vfs.readBuffer(key); // throws if missing → surfaced as is_error
      const offset = getOptionalInteger(input, 'offset') ?? 1;
      // limit stays undefined when omitted so each extractor applies its own
      // type-appropriate default (pages for PDFs, lines for text documents).
      const limit = getOptionalInteger(input, 'limit');
      const window = limit === undefined ? { offset } : { offset, limit };
      const result = await extractor.extract({ name: key, content }, window);
      if (result.attachments && result.attachments.length > 0) {
        ctx.attachBlocks(result.attachments.map(toContentBlock));
      }
      return result.text || `Processed "${key}" as ${extractor.label}, but no content was produced.`;
    },
  };
}
