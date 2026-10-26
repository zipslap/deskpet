// Builds the macOS-only native helpers (speech recogniser, window lister, desktop-layer addon). On Windows and Linux there is nothing to
// build: speech recognition runs in Python (npm run speech) and the window features are simply off. Never fails the caller.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('build-helper: nothing to build on this system (the native helpers are macOS only).')
  process.exit(0)
}
spawnSync('bash', [join(dirname(fileURLToPath(import.meta.url)), 'build-helper.sh')], { stdio: 'inherit' })
process.exit(0)
