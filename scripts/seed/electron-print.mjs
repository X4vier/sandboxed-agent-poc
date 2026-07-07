// Electron worker: render HTML files to PDF via Chromium's printToPDF.
// Invoked as `electron scripts/seed/electron-print.mjs <jobsJsonPath>` where the
// jobs file is JSON: [{ html: "/abs/in.html", pdf: "/abs/out.pdf" }, ...].
// Chromium PDFs carry a real text layer the app's PDF extractor reads cleanly.
import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const jobsPath = process.argv[process.argv.length - 1];

async function printOne(job) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadURL(pathToFileURL(job.html).href);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }, // inches
      pageSize: 'A4',
    });
    await writeFile(job.pdf, pdf);
    process.stdout.write(`  PDF ${job.pdf.split('/').pop()} (${(pdf.length / 1024).toFixed(0)}KB)\n`);
  } finally {
    win.destroy();
  }
}

// Render up to CONCURRENCY windows at once — printToPDF is I/O-bound on layout
// and image decode, so a few in flight is a large speedup over serial.
const CONCURRENCY = 4;

app.whenReady().then(async () => {
  try {
    const jobs = JSON.parse(await readFile(jobsPath, 'utf8'));
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= jobs.length) return;
        await printOne(jobs[i]);
      }
    });
    await Promise.all(workers);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
