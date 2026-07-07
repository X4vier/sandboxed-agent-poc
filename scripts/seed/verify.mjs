import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfExtractor } from '../../src/main/documents/extractors/pdf.ts';
import { docxExtractor } from '../../src/main/documents/extractors/docx.ts';

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed-data');
const files = (await readdir(dir)).filter((f) => /\.(pdf|docx)$/.test(f));
for (const f of files) {
  const content = await readFile(join(dir, f));
  const ext = f.endsWith('.pdf') ? pdfExtractor : docxExtractor;
  const r = await ext.extract({ name: f, content }, { offset: 1 });
  const attached = r.attachments?.length ?? 0;
  console.log(`\n=== ${f} (${(content.length/1024).toFixed(0)}KB) — ${r.text.length} chars, ${attached} attach ===`);
  console.log(r.text.slice(0, 450).replace(/\n+/g, ' \\n '));
}
