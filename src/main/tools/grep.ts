import type { AgentTool } from '../agent/types';
import type { IndexedDocument } from '../documents/textIndex';
import { textIndexFor } from '../documents/textIndex';
import { getOptionalBoolean, getOptionalInteger, getOptionalString, getString } from './inputs';
import { matchesGlobFilter } from './glob';
import { underPath } from './pathUtils';
import { GREP_MAX_LINE_LENGTH, truncateLine } from './truncate';

const GREP_MATCH_CAP = 100;

const GREP_OUTPUT_MODES = ['content', 'files_with_matches', 'count'] as const;
type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

/** Cap a match line to the Grep per-line length. */
function capGrepLine(line: string): string {
  return truncateLine(line, GREP_MAX_LINE_LENGTH).text;
}

/** Escape a string so it matches literally when compiled as a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand match line indices into merged, sorted [start, end] ranges that include
 * `context` lines on each side (grep -C). Overlapping/adjacent ranges are merged.
 */
function contextRanges(matchIndices: number[], context: number, lineCount: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const i of matchIndices) {
    const start = Math.max(0, i - context);
    const end = Math.min(lineCount - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

export const grepTool: AgentTool = {
  name: 'Grep',
  description:
    'Search file contents, including extracted text inside PDFs and DOCX files, with a regular expression. Input: { "pattern": "<regex>", "path"?: ' +
    '"<dir scope>", "glob"?: "<filename filter e.g. *.ts>", "-i"?: false, "output_mode"?: ' +
    '"content" }. pattern is ALWAYS a JavaScript regular expression (escape literal metacharacters). ' +
    'output_mode: "content" (default) returns "path:line: text" for plain text, "path (page N): text" ' +
    'for PDFs, and "path: text" for DOCX; "files_with_matches" returns matching paths only; "count" ' +
    `returns "path:count". Set "-i" for case-insensitive; "literal" to match the pattern as plain ` +
    'text (metacharacters escaped for you); "context" to include N lines before and after each match ' +
    `(content mode). Each match line is truncated to ${GREP_MAX_LINE_LENGTH} characters and up to ` +
    `${GREP_MATCH_CAP} results are returned, then a truncation note.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'Optional directory prefix to search under.' },
      glob: { type: 'string', description: 'Optional filename filter, e.g. "*.ts".' },
      '-i': { type: 'boolean', description: 'Case-insensitive search.' },
      literal: {
        type: 'boolean',
        description: 'Treat pattern as literal text rather than a regex (default false).',
      },
      context: {
        type: 'number',
        description: 'Lines of context to show before and after each match, content mode (default 0).',
      },
      output_mode: {
        type: 'string',
        enum: [...GREP_OUTPUT_MODES],
        description: 'content | files_with_matches | count (default content).',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const pattern = getString(input, 'pattern');
    const rawPath = getOptionalString(input, 'path');
    const globFilter = getOptionalString(input, 'glob');
    const caseInsensitive = getOptionalBoolean(input, '-i');
    const literal = getOptionalBoolean(input, 'literal');
    const context = Math.max(0, getOptionalInteger(input, 'context') ?? 0);
    const outputMode = (getOptionalString(input, 'output_mode') ?? 'content') as GrepOutputMode;
    const prefix = rawPath ? ctx.normalizePath(rawPath) : undefined;

    if (!GREP_OUTPUT_MODES.includes(outputMode)) {
      return `Invalid output_mode "${outputMode}". Use one of: ${GREP_OUTPUT_MODES.join(', ')}.`;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, caseInsensitive ? 'i' : '');
    } catch (e) {
      return `Invalid regular expression: ${(e as Error).message}`;
    }

    const results: string[] = [];
    const notes: string[] = [];
    let omitted = 0;
    const addResult = (line: string): void => {
      if (results.length < GREP_MATCH_CAP) results.push(line);
      else omitted += 1;
    };
    const searchLines = (
      lines: string[],
      format: (line: string, lineNumber: number) => string,
    ): number => {
      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? '')) matchIndices.push(i);
      }
      if (outputMode === 'content' && matchIndices.length > 0) {
        if (context <= 0) {
          for (const i of matchIndices) addResult(format(lines[i] ?? '', i + 1));
        } else {
          // Include N lines of context per match, merging overlaps and separating
          // groups with "--" (grep -C). Context lines use the same formatting.
          const ranges = contextRanges(matchIndices, context, lines.length);
          let firstGroup = true;
          for (const [start, end] of ranges) {
            if (!firstGroup) addResult('--');
            firstGroup = false;
            for (let i = start; i <= end; i++) addResult(format(lines[i] ?? '', i + 1));
          }
        }
      }
      return matchIndices.length;
    };
    const searchDocument = async (key: string, document: IndexedDocument): Promise<number> => {
      if (document.skippedReason) {
        notes.push(`[skipped ${key}: ${document.skippedReason}]`);
        return 0;
      }
      let count = 0;
      for (const unit of document.units) {
        const lines = unit.text.split('\n');
        count += searchLines(lines, (line) => {
          const capped = capGrepLine(line);
          return unit.label === 'page' ? `${key} (page ${unit.index}): ${capped}` : `${key}: ${capped}`;
        });
      }
      return count;
    };

    const textIndex = textIndexFor(ctx.vfs);
    for (const key of ctx.vfs.keys()) {
      if (!underPath(key, prefix)) continue;
      if (globFilter && !matchesGlobFilter(key, globFilter)) continue;

      const fileCount = textIndex.supports(key)
        ? await searchDocument(key, await textIndex.get(ctx.vfs, key))
        : (() => {
            const decoded = ctx.vfs.readText(key);
            if (!decoded.ok) return 0; // skip unsupported binary
            return searchLines(decoded.text.split('\n'), (line, lineNumber) =>
              `${key}:${lineNumber}: ${capGrepLine(line)}`,
            );
          })();

      if (fileCount > 0 && outputMode !== 'content') {
        addResult(outputMode === 'count' ? `${key}:${fileCount}` : key);
      }
    }

    const suffix = [
      ...notes,
      ...(omitted > 0
        ? [`[... ${omitted} more matches — refine your pattern or add an include filter]`]
        : []),
    ];
    if (results.length === 0) {
      return suffix.length > 0 ? `No matches found.\n\n${suffix.join('\n')}` : 'No matches found.';
    }
    return results.join('\n') + (suffix.length > 0 ? `\n\n${suffix.join('\n')}` : '');
  },
};
