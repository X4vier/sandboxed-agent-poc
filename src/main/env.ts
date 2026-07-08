import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env into process.env. This module has NO other exports and must be
// imported for its side effect *before* any module that reads process.env at
// import time (notably agent/client.ts, which captures ANTHROPIC_API_KEY at
// module init). ES module imports are evaluated before the importing module's
// body, so doing this inside index.ts's body runs too late — hence a dedicated
// module imported first.
//
// electron-vite does not inject unprefixed vars (ANTHROPIC_API_KEY, AGENT_MODEL,
// …) into the main process, so we load them explicitly. We resolve .env from the
// build layout (out/main → ../../) rather than process.cwd(): the main process's
// cwd is not guaranteed to be the project root (notably under the WSL→Windows
// dev launch), so a cwd-relative lookup silently misses it. No-op if there is no
// .env (packaged app) or the ambient environment already carries the vars.
try {
  const here = dirname(fileURLToPath(import.meta.url));
  process.loadEnvFile(join(here, '../../.env'));
} catch {
  // No .env present — rely on the ambient environment.
}
