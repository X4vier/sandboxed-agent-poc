// Generate two sample seed docs for manual review: one DOCX, one PDF.
//   node scripts/seed/review-samples.mjs
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchArticleHtml, parseArticle, hydrateImages, blocksToDocx, blocksToHtml } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'seed-review');
const tmpDir = join(root, 'node_modules', '.cache', 'seed-tmp');

async function build(title) {
  const blocks = await hydrateImages(parseArticle(await fetchArticleHtml(title), title));
  const p = blocks.filter((b) => b.kind === 'para').length;
  const i = blocks.filter((b) => b.kind === 'image').length;
  process.stdout.write(`  ${title}: ${p} paragraphs, ${i} images\n`);
  return blocks;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  // DOCX sample
  const docxBlocks = await build('Octopus');
  await writeFile(join(outDir, 'octopus.docx'), await blocksToDocx(docxBlocks, 'Octopus'));

  // PDF sample via Chromium
  const pdfBlocks = await build('Photosynthesis');
  const htmlPath = join(tmpDir, 'photosynthesis.html');
  await writeFile(htmlPath, blocksToHtml(pdfBlocks, 'Photosynthesis'));
  const jobs = [{ html: htmlPath, pdf: join(outDir, 'photosynthesis.pdf') }];
  const jobsPath = join(tmpDir, 'jobs.json');
  await writeFile(jobsPath, JSON.stringify(jobs));

  await new Promise((resolve, reject) => {
    const electron = join(root, 'node_modules', '.bin', 'electron');
    const proc = spawn(electron, [join(root, 'scripts', 'seed', 'electron-print.mjs'), jobsPath], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`electron exited ${code}`))));
    proc.on('error', reject);
  });

  await rm(tmpDir, { recursive: true, force: true });
  process.stdout.write(`\nWrote octopus.docx and photosynthesis.pdf to ${outDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
