// Renderer bootstrap. Real UI is wired in the IPC+UI build step.
const app = document.getElementById('app');
if (app) {
  app.textContent = 'Sandboxed Agent PoC — UI initializing…';
}
