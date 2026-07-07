import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { AgentTool } from '../agent/types';
import type { Attachment, ExtractorRegistry } from '../documents';
import { getString } from './inputs';

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
 * extension. Extracted text is returned inline; images and un-parseable PDFs
 * are attached to the conversation via {@link ToolContext.attachBlocks}.
 */
export function createReadDocumentTool(registry: ExtractorRegistry): AgentTool {
  const supported = registry
    .supportedExtensions()
    .map((e) => `.${e}`)
    .join(', ');
  return {
    name: 'read_document',
    description:
      'Read a non-plain-text document from the workspace by converting it to model-readable ' +
      `content. Input: { "path": "<workspace-relative path>" }. Supported types: ${supported}. ` +
      'Extracted text is returned directly; images and un-parseable PDFs are attached so you can ' +
      'see them. Use Read for plain text (.txt, .md, source code).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
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
      const result = await extractor.extract({ name: key, content });
      if (result.attachments && result.attachments.length > 0) {
        ctx.attachBlocks(result.attachments.map(toContentBlock));
      }
      return result.text || `Processed "${key}" as ${extractor.label}, but no content was produced.`;
    },
  };
}
