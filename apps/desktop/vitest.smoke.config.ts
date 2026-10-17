import { defineConfig } from 'vitest/config';

/**
 * Packaged-shell smoke test for the desktop companion. Unlike the unit config, this one
 * spawns the real Electron binary, so it is kept separate and run only via `test:smoke`
 * (never the default `pnpm test`, never CI). Timeouts are generous because launching
 * Electron and loading a window is far slower than a pure-Node unit test.
 */
export default defineConfig({
  test: {
    name: 'smoke',
    environment: 'node',
    include: ['test/smoke/**/*.smoke.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
