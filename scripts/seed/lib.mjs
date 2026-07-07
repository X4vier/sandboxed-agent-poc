// Shared helpers for the seed-corpus generator: fetch Wikipedia REST HTML,
// parse it into an ordered block outline, download referenced images, and
// render that outline to a .docx via the `docx` library.
import { parse } from 'node-html-parser';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
} from 'docx';

const UA = 'agent-spike-seed-generator/0.1 (educational PoC; contact xavier.orourke@affinda.com)';

// Simple on-disk fetch cache keyed by URL hash, so re-runs (and recovery from a
// mid-run failure) don't re-download ~600 network resources. Safe to delete.
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache', 'seed-fetch');

async function cacheGet(url) {
  try {
    return await readFile(join(CACHE_DIR, createHash('sha1').update(url).digest('hex')));
  } catch {
    return null;
  }
}
async function cacheSet(url, buf) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, createHash('sha1').update(url).digest('hex')), buf);
  } catch {
    /* cache is best-effort */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a URL as a Buffer with retry + backoff, honouring 429/503 Retry-After.
 * Wikimedia rate-limits bursts of image requests, so bare fetches drop ~80% of
 * images under concurrency; retries (and the disk cache) recover them.
 */
async function fetchBuffer(url, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://en.wikipedia.org/' } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      return null; // 404 etc. — not worth retrying
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
  return null;
}

/** Fetch the canonical REST HTML for an article title (disk-cached). */
export async function fetchArticleHtml(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const cached = await cacheGet(url);
  if (cached) return cached.toString('utf8');
  const buf = await fetchBuffer(url);
  if (!buf) throw new Error(`fetch failed for ${title}`);
  await cacheSet(url, buf);
  return buf.toString('utf8');
}

/** Download an image; returns { buffer, type } or null if unusable (disk-cached). */
async function fetchImage(src) {
  const url = src.startsWith('//') ? `https:${src}` : src;
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'jpg' : ext === 'png' ? 'png' : ext === 'gif' ? 'gif' : null;
  if (type === null) return null; // skip svg/webp — docx ImageRun wants a raster type
  let buffer = await cacheGet(url);
  if (!buffer) {
    buffer = await fetchBuffer(url);
    if (!buffer) return null;
    await cacheSet(url, buffer);
  }
  if (buffer.length < 1024 || buffer.length > 8 * 1024 * 1024) return null; // skip icons / oversized
  return { buffer, type };
}

// Section headings that mark the end of the article body worth keeping.
const STOP_HEADINGS = /^(references|notes|citations|external links|further reading|see also|bibliography|sources|footnotes)$/i;

function cleanText(node) {
  // Drop reference superscripts and edit links before reading text.
  for (const sup of node.querySelectorAll('sup')) sup.remove();
  return node.text.replace(/\s+/g, ' ').trim();
}

// UI chrome, rating icons, tiny flags-in-links, edit pencils, etc. — never real
// content imagery. Wikipedia serves SVG originals (flags, maps) as .png thumbs,
// so those still qualify as raster images.
const SKIP_IMG = /OOjs|edit|Commons-logo|Wiki(source|quote|books|news|versity|voyage)|Increase|Decrease|Steady|Ambox|Symbol_|Question_book|padlock|Red[_ ]?pointer|Cscr|Semi-protection|Location_dot|People_icon|Gnome|Nuvola|magnify|Disc_Plain|Folder_|Text_document|Star_(full|empty)/i;

const MAX_IMAGES = 8;

/**
 * Parse REST HTML into an ordered array of blocks:
 *   { kind: 'heading', level, text } | { kind: 'para', text }
 *   | { kind: 'image', src, caption } | { kind: 'table', rows: string[][] }
 * Images are returned as srcs (downloaded later, so parsing stays sync/fast).
 * The lead infobox (flag, coat of arms, locator map, photo montage) is mined
 * for images first — for uniform topics like countries most imagery lives there
 * rather than in standalone <figure> elements.
 */
export function parseArticle(html, title) {
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  const body = root.querySelector('body') ?? root;
  const blocks = [{ kind: 'heading', level: 0, text: title }];
  let stopped = false;
  const seen = new Set();

  const pushImage = (img, minW, caption) => {
    const src = img?.getAttribute('src');
    const w = Number(img?.getAttribute('width') ?? 0);
    if (!src || w < minW || seen.has(src) || SKIP_IMG.test(src) || seen.size >= MAX_IMAGES) return;
    seen.add(src);
    blocks.push({ kind: 'image', src, caption: (caption || img.getAttribute('alt') || '').trim() });
  };

  // Lead infobox imagery (flag, arms, map, montage), placed right after the
  // title like a real article. Capped so standalone <figure>s still get slots.
  const infobox = body.querySelectorAll('table').find((t) => /infobox/.test(t.getAttribute('class') || ''));
  if (infobox) {
    for (const img of infobox.querySelectorAll('img')) {
      if (seen.size >= 4) break;
      pushImage(img, 60);
    }
  }

  const walk = (node) => {
    if (stopped) return;
    for (const child of node.childNodes) {
      if (stopped) break;
      if (child.nodeType !== 1) continue; // elements only
      const tag = child.rawTagName?.toLowerCase();
      const cls = child.getAttribute?.('class') ?? '';

      if (/^h[2-4]$/.test(tag ?? '')) {
        const text = cleanText(child);
        if (STOP_HEADINGS.test(text)) { stopped = true; return; }
        if (text) blocks.push({ kind: 'heading', level: Number(tag[1]) - 1, text });
      } else if (tag === 'p') {
        const text = cleanText(child);
        if (text.length > 1) blocks.push({ kind: 'para', text });
      } else if (tag === 'figure') {
        const cap = child.querySelector('figcaption');
        pushImage(child.querySelector('img'), 100, cap ? cleanText(cap) : '');
      } else if (tag === 'table' && /wikitable/.test(cls)) {
        const rows = [];
        for (const tr of child.querySelectorAll('tr')) {
          const cells = tr.querySelectorAll('th,td').map((c) => cleanText(c)).filter(() => true);
          if (cells.length) rows.push(cells);
          if (rows.length >= 15) break;
        }
        if (rows.length >= 2) blocks.push({ kind: 'table', rows: rows.map((r) => r.slice(0, 6)) });
      } else if (tag === 'section' || tag === 'div') {
        walk(child); // descend into structural containers
      }
    }
  };
  walk(body);
  return blocks;
}

/** Resolve image blocks in place: fetch bytes, drop any that fail. */
export async function hydrateImages(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind !== 'image') { out.push(b); continue; }
    const img = await fetchImage(b.src);
    if (img) out.push({ ...b, ...img });
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a hydrated block outline to a self-contained HTML string (images
 * inlined as data URIs) suitable for Chromium `printToPDF`. Chromium's PDFs
 * carry a proper text layer with ToUnicode maps, which the app's PDF extractor
 * reads cleanly — unlike glyph-subset output from office suites.
 */
export function blocksToHtml(blocks, title) {
  const parts = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const tag = b.level === 0 ? 'h1' : b.level === 1 ? 'h2' : b.level === 2 ? 'h3' : 'h4';
      parts.push(`<${tag}>${escapeHtml(b.text)}</${tag}>`);
    } else if (b.kind === 'para') {
      parts.push(`<p>${escapeHtml(b.text)}</p>`);
    } else if (b.kind === 'image' && b.buffer) {
      const mime = b.type === 'jpg' ? 'image/jpeg' : `image/${b.type}`;
      const uri = `data:${mime};base64,${b.buffer.toString('base64')}`;
      parts.push(`<figure><img src="${uri}" alt="${escapeHtml(b.caption)}"/>${
        b.caption ? `<figcaption>${escapeHtml(b.caption)}</figcaption>` : ''
      }</figure>`);
    } else if (b.kind === 'table') {
      const rows = b.rows.map((cells) =>
        `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
      parts.push(`<table>${rows}</table>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.5; color: #1a1a1a;
         max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 30px; border-bottom: 2px solid #333; padding-bottom: 8px; }
  h2 { font-size: 22px; margin-top: 28px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  h3 { font-size: 18px; margin-top: 20px; } h4 { font-size: 16px; }
  p { margin: 10px 0; } figure { margin: 18px 0; text-align: center; }
  img { max-width: 100%; height: auto; border: 1px solid #eee; }
  figcaption { font-size: 13px; color: #666; font-style: italic; margin-top: 6px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
  td { border: 1px solid #bbb; padding: 6px 8px; vertical-align: top; }
</style></head><body>${parts.join('\n')}</body></html>`;
}

const HEADING_BY_LEVEL = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

/** Render a hydrated block outline to a .docx file buffer. */
export async function blocksToDocx(blocks, title) {
  const children = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      children.push(new Paragraph({ text: b.text, heading: HEADING_BY_LEVEL[Math.min(b.level, 3)] }));
    } else if (b.kind === 'para') {
      children.push(new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 160 } }));
    } else if (b.kind === 'image' && b.buffer) {
      const width = Math.min(b.width ? Number(b.width) : 400, 450);
      const height = Math.round(width * 0.7);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: b.type, data: b.buffer, transformation: { width, height } })],
      }));
      if (b.caption) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: b.caption, italics: true, size: 18, color: '666666' })],
          spacing: { after: 200 },
        }));
      }
    } else if (b.kind === 'table') {
      children.push(blockToTable(b));
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    }
  }
  const doc = new Document({
    creator: 'agent-spike seed generator',
    title,
    description: `Seed document derived from the Wikipedia article "${title}".`,
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

function blockToTable(b) {
  const cols = Math.max(...b.rows.map((r) => r.length));
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'BBBBBB' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: b.rows.map((cells) => new TableRow({
      children: Array.from({ length: cols }, (_, i) => new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: cells[i] ?? '', size: 20 })] })],
      })),
    })),
  });
}
