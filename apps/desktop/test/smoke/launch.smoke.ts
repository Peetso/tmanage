import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Packaged-shell smoke test for the TManage desktop companion.
 *
 * This spec launches the compiled shell under the real Electron binary (via the
 * `harness.ts` main entry, compiled to `test/smoke/dist/harness.js`) and asserts the
 * structured result the harness prints. It is NOT part of the unit suite (`pnpm test`
 * only picks up `*.test.ts`) and is deliberately not wired into CI: it needs the
 * Electron runtime and is driven by `pnpm --filter @tmanage/desktop test:smoke`.
 */

const requireCjs = createRequire(import.meta.url);
// The `electron` npm package, required from Node, resolves to the path of its binary.
const electronPath = requireCjs('electron') as string;
const harnessPath = fileURLToPath(new URL('./dist/harness.js', import.meta.url));

interface SmokeResult {
  passed: boolean;
  checks: Record<string, boolean>;
  error?: string;
}

function runSmoke(): Promise<{ code: number | null; result: SmokeResult | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [harnessPath], {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    child.on('error', reject);
    child.on('close', (code) => {
      const line = output.split(/\r?\n/).find((l) => l.startsWith('SMOKE_RESULT '));
      let result: SmokeResult | null = null;
      if (line) {
        try {
          result = JSON.parse(line.slice('SMOKE_RESULT '.length)) as SmokeResult;
        } catch {
          result = null;
        }
      }
      resolve({ code, result, output });
    });
  });
}

describe('desktop packaged-shell smoke', () => {
  it('boots the shell, enforces the allowlist, registers tray/deep-link, and quits cleanly', async () => {
    const { code, result, output } = await runSmoke();

    // A readable failure: surface the harness output when the result line is missing.
    expect(result, `no SMOKE_RESULT line in output:\n${output}`).not.toBeNull();
    const checks = result!.checks;

    expect(checks.windowOpened, 'main.js opened a BrowserWindow').toBe(true);
    expect(checks.loadedOnOrigin, 'window loaded the configured origin').toBe(true);
    expect(checks.activityBridge, 'preload exposes the idle-state bridge').toBe(true);
    expect(checks.navGuardWired, 'navigation guard wired onto the window').toBe(true);
    expect(checks.navGuardAllowsSameOrigin, 'same-origin navigation stays in-app').toBe(true);
    expect(checks.navGuardRefusesOffAllowlist, 'off-allowlist navigation refused').toBe(true);
    expect(checks.navGuardBlocksDangerousScheme, 'file: scheme blocked').toBe(true);
    expect(checks.trayConstructs, 'tray constructs in the Electron runtime').toBe(true);
    expect(checks.deepLinkRoutesOnOrigin, 'deep link routes onto the app origin').toBe(true);
    expect(checks.deepLinkNeverEscapesOrigin, 'deep link cannot escape the origin').toBe(true);
    expect(checks.deepLinkHandlersRegistered, 'deep-link hand-off handlers registered').toBe(true);

    expect(result!.passed, `one or more checks failed: ${JSON.stringify(checks)}`).toBe(true);
    // Clean quit: the harness ends via app.quit() with a zero exit code on success.
    expect(code, `electron exited non-zero:\n${output}`).toBe(0);
  }, 60000);
});
