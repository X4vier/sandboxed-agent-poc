import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerIpc } from './ipc';

// Load .env from the working directory into process.env. electron-vite does not
// inject unprefixed vars (ANTHROPIC_API_KEY, AGENT_MODEL, …) into the main
// process, so we load them explicitly. No-op if there is no .env (packaged app).
try {
  process.loadEnvFile();
} catch {
  // No .env present — rely on the ambient environment.
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    title: 'Sandboxed Agent PoC',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Security-critical: keep the renderer fully sandboxed.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  registerIpc(win);

  // Never allow the renderer to open arbitrary windows or navigate away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
