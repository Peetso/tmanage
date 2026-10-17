import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run Playwright against this package's VR config **without** `@tmanage/web` declaring
 * `@playwright/test` itself.
 *
 * `packages/ui` can write `playwright test` in its `test:vr` script because it owns a
 * `@playwright/test` devDependency. Adding the same dependency here would change this package's
 * entry in `pnpm-lock.yaml`, and a locked install (`pnpm install --frozen-lockfile`) would then
 * refuse — the repository's standing rule. So this launcher borrows the one copy the workspace
 * already has: `next` pulls `@playwright/test@1.62.1` as a peer, pnpm places it in the shared
 * virtual store, and pointing `NODE_PATH` at that store lets the config and spec resolve
 * `@playwright/test` from here. Nothing new is installed; the lockfile is untouched.
 *
 * Any extra arguments pass straight through, so `pnpm --filter @tmanage/web vr --update-snapshots`
 * regenerates the baselines.
 */

const vrDir = dirname(fileURLToPath(import.meta.url));
const appWebDir = join(vrDir, '..');
const repoRoot = join(appWebDir, '..', '..');
const store = join(repoRoot, 'node_modules', '.pnpm', 'node_modules');
const cli = join(store, '@playwright', 'test', 'cli.js');

if (!existsSync(cli)) {
  console.error(
    `Could not find the workspace Playwright CLI at ${cli}.\n` +
      `Run \`pnpm install\` at the repository root first.`,
  );
  process.exit(1);
}

const nodePath = process.env['NODE_PATH']
  ? `${process.env['NODE_PATH']}${process.platform === 'win32' ? ';' : ':'}${store}`
  : store;

const child = spawn(
  process.execPath,
  [cli, 'test', '-c', 'vr/playwright.config.ts', ...process.argv.slice(2)],
  {
    cwd: appWebDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: nodePath },
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
