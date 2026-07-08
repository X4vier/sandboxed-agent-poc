// Build the default seed corpus: fetch ~100 country articles from Wikipedia and
// render half to rich .docx and half to .pdf so both of the app's document
// parsers are exercised on genuinely nontrivial files.
//
//   node scripts/seed/generate.mjs [--limit N] [--out DIR] [--concurrency N]
//
// Output lands in seed-data/ (committed, bundled with the app). Network I/O is
// parallelised with a concurrency pool and disk-cached; the 50 Chromium PDF
// renders run in one Electron process with concurrent windows. Idempotent.
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLES } from './articles.mjs';
import { fetchArticleHtml, parseArticle, hydrateImages, blocksToDocx, blocksToHtml } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (flag, def) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : def);
const limit = Number(argVal('--limit', ARTICLES.length));
const outDir = argVal('--out', join(root, 'seed-data'));
const concurrency = Number(argVal('--concurrency', 8));
const target = Number(argVal('--target', 200)); // total files wanted (split 50/50)
const tmpDir = join(root, 'node_modules', '.cache', 'seed-tmp');

const slug = (title) => title.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Run `fn` over `items` with at most `n` in flight; preserves input order. */
async function mapPool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function runElectron(jobsPath) {
  return new Promise((resolve, reject) => {
    const electron = join(root, 'node_modules', '.bin', 'electron');
    const proc = spawn(electron, [join(root, 'scripts', 'seed', 'electron-print.mjs'), jobsPath], {
      stdio: 'inherit', env: { ...process.env },
    });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`electron exited ${code}`))));
    proc.on('error', reject);
  });
}

async function main() {
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const titles = ARTICLES.slice(0, limit);
  process.stdout.write(`Fetching ${titles.length} articles (concurrency ${concurrency})…\n`);

  // Stage 1 (parallel, network-bound): fetch + parse + download images.
  const prepared = await mapPool(titles, concurrency, async (title, i) => {
    try {
      const blocks = await hydrateImages(parseArticle(await fetchArticleHtml(title), title));
      const paras = blocks.filter((b) => b.kind === 'para').length;
      const imgs = blocks.filter((b) => b.kind === 'image').length;
      if (paras < 5) throw new Error(`too thin (${paras}p)`);
      process.stdout.write(`  [${i + 1}/${titles.length}] ok    ${title} (${paras}p, ${imgs} imgs)\n`);
      return { title, blocks, paras, imgs };
    } catch (e) {
      process.stdout.write(`  [${i + 1}/${titles.length}] SKIP  ${title} — ${e.message}\n`);
      return null;
    }
  });

  const good = prepared.filter(Boolean).slice(0, target);
  process.stdout.write(`\nPrepared ${good.length} articles; writing DOCX + queuing PDF…\n`);

  // Stage 2: assign formats (interleaved so each format spans all continents)
  // and emit. DOCX is written directly; PDF is rendered from HTML by Electron.
  const manifest = [];
  const pdfJobs = [];
  await Promise.all(good.map(async (a, i) => {
    const name = slug(a.title);
    if (i % 2 === 0) {
      await writeFile(join(outDir, `${name}.docx`), await blocksToDocx(a.blocks, a.title));
      manifest.push({ title: a.title, file: `${name}.docx`, format: 'docx', paragraphs: a.paras, images: a.imgs });
    } else {
      const html = join(tmpDir, `${name}.html`);
      await writeFile(html, blocksToHtml(a.blocks, a.title));
      pdfJobs.push({ html, pdf: join(outDir, `${name}.pdf`) });
      manifest.push({ title: a.title, file: `${name}.pdf`, format: 'pdf', paragraphs: a.paras, images: a.imgs });
    }
  }));

  if (pdfJobs.length) {
    process.stdout.write(`\nRendering ${pdfJobs.length} PDFs via Chromium…\n`);
    const jobsPath = join(tmpDir, 'jobs.json');
    await writeFile(jobsPath, JSON.stringify(pdfJobs));
    await runElectron(jobsPath);
  }

  const produced = (await readdir(outDir)).filter((f) => /\.(docx|pdf)$/.test(f));
  const docxN = produced.filter((f) => f.endsWith('.docx')).length;
  const pdfN = produced.filter((f) => f.endsWith('.pdf')).length;
  await writeFile(join(root, 'scripts', 'seed', 'manifest.json'), JSON.stringify(manifest, null, 2));
  await rm(tmpDir, { recursive: true, force: true });
  process.stdout.write(`\nDone: ${produced.length} files in ${outDir} (${docxN} docx, ${pdfN} pdf)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
