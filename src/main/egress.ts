import { session } from 'electron';
import { recordNetworkRequest } from './audit';

/**
 * Egress guard for the Chromium network stack (everything the renderer or any
 * web contents could request), complementing the main-process fetch guard in
 * audit.ts. In production the renderer is loaded from file:// and should make
 * no http(s)/ws requests at all; any attempt is blocked and shows up in the
 * audit ledger as a blocked host.
 *
 * Together the two guards cover both request paths the app has. What they do
 * NOT cover is a hypothetical raw Node socket (net/http) opened by main-process
 * code — no such code exists, and the README's OS-level check is the honest
 * backstop for that class.
 */
export function installChromiumEgressGuard(): void {
  // electron-vite dev serves the renderer (and HMR websocket) from localhost;
  // exempt exactly that origin so the guard behaves the same in dev.
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  let devHost: string | null = null;
  if (devServer) {
    try {
      devHost = new URL(devServer).host;
    } catch {
      devHost = null;
    }
  }

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    // Local schemes (file:, devtools:, data:, blob:, chrome:) never leave the
    // machine; only network-capable schemes are subject to the allowlist.
    if (!/^(https?|wss?):$/.test(url.protocol)) {
      callback({});
      return;
    }
    if (devHost && url.host === devHost) {
      callback({});
      return;
    }
    callback({ cancel: !recordNetworkRequest(url.hostname) });
  });
}
