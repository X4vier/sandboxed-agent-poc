// MUST be first: loads .env into process.env before any module that reads it at
// import time (e.g. agent/client.ts) is evaluated. See src/main/env.ts.
import './env';

import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerIpc } from './ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    title: 'Sandboxed Agent PoC',
    // Dev runs launch the stock electron.exe (electron-builder's win.icon only
    // applies to the packaged exe), so set the window icon explicitly to get the
    // mango on the taskbar in dev too. __dirname is out/main → repo-root build/.
    icon: join(__dirname, '../../build/icon.ico'),
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
