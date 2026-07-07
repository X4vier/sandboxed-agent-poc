/**
 * Minimal, dependency-free Markdown renderer for assistant responses.
 *
 * Security: this builds real DOM nodes via document.createElement and text
 * nodes — it NEVER assigns innerHTML from model output, so injected HTML/scripts
 * cannot execute. That matches the app's strict CSP (script-src 'self') and its
 * no-external-dependency posture, and keeps untrusted model text inert.
 *
 * Scope is intentionally small (headings, emphasis, code, lists, blockquotes,
 * links) — enough for chat-style responses, not a spec-complete CommonMark
 * implementation. It is safe to re-run on every streaming delta.
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```/;
const UL_ITEM = /^\s*[-*+]\s+/;
const OL_ITEM = /^\s*\d+\.\s+/;
const QUOTE = /^\s*>\s?/;
const BLANK = /^\s*$/;

/** Inline spans: code, bold, italic, links. */
const INLINE_SOURCE =
  '(`+)([\\s\\S]*?)\\1|\\*\\*([\\s\\S]+?)\\*\\*|__([\\s\\S]+?)__|\\*([^*\\n]+?)\\*|_([^_\\n]+?)_|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)';

function renderInline(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // A fresh regex per call: this function recurses (emphasis contents), and a
  // shared /g regex's lastIndex would be clobbered across recursion levels.
  const re = new RegExp(INLINE_SOURCE, 'g');
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const code = document.createElement('code');
      code.textContent = m[2] ?? '';
      nodes.push(code);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const strong = document.createElement('strong');
      strong.append(...renderInline((m[3] ?? m[4]) as string));
      nodes.push(strong);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const em = document.createElement('em');
      em.append(...renderInline((m[5] ?? m[6]) as string));
      nodes.push(em);
    } else if (m[7] !== undefined && m[8] !== undefined) {
      const a = document.createElement('a');
      a.textContent = m[7];
      // Only linkify safe web schemes; anything else stays plain text.
      if (/^https?:\/\//i.test(m[8])) {
        a.href = m[8];
        a.title = m[8];
        // target=_blank routes the click through the main-process window-open
        // handler, which opens it in the system browser (see src/main/index.ts).
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      nodes.push(a);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line) ||
    QUOTE.test(line) ||
    BLANK.test(line)
  );
}

export function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (FENCE.test(line)) {
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence (a no-op past EOF for unterminated blocks)
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code.join('\n');
      pre.append(codeEl);
      frag.append(pre);
      continue;
    }

    // Heading.
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const el = document.createElement(`h${level}`);
      el.append(...renderInline(heading[2]));
      frag.append(el);
      i += 1;
      continue;
    }

    // Blank line — skip.
    if (BLANK.test(line)) {
      i += 1;
      continue;
    }

    // List (ordered or unordered).
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const marker = ordered ? OL_ITEM : UL_ITEM;
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && marker.test(lines[i])) {
        const li = document.createElement('li');
        li.append(...renderInline(lines[i].replace(marker, '')));
        list.append(li);
        i += 1;
      }
      frag.append(list);
      continue;
    }

    // Blockquote — recurse on the stripped content.
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      const bq = document.createElement('blockquote');
      bq.append(renderMarkdown(quoted.join('\n')));
      frag.append(bq);
      continue;
    }

    // Paragraph — gather until a blank line or the next block starts.
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    const p = document.createElement('p');
    p.append(...renderInline(para.join('\n')));
    frag.append(p);
  }

  return frag;
}
