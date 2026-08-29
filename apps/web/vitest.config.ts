import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The screen harness.
 *
 * `jsdom` for the same reason `packages/ui` gives: this machine has no container runtime
 * and no browser budget, so what jsdom can prove is proved here and what it cannot —
 * real layout, real painting, a real screen reader — is named as open in
 * `docs/implementation-status.md` rather than implied by a green run.
 *
 * Every screen under test is a client component. Server components are not rendered here;
 * the layouts that are server components hold no logic of their own beyond composition,
 * and the shells they compose are tested directly.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    /**
     * Raised from vitest's 5 s default for one measured reason: `ON-01` renders the
     * platform's full IANA timezone list — around 600 `<option>` elements — and axe-core
     * walks every one of them. That pass takes well over five seconds in jsdom on this
     * machine.
     *
     * The alternative would have been to shorten the timezone list, which would silently
     * exclude whoever lives in the part that was cut. A slow test is the cheaper problem.
     *
     * Raised again from 30 s on 2026-08-29, and again from measurement rather than
     * irritation: the ON-01 axe pass takes 9.6 s running ALONE on an idle machine, and a
     * full `pnpm test` runs sixteen jsdom workers side by side, which multiplied that past
     * 30 s in four consecutive full-suite runs while passing every time the file ran by
     * itself. The assertion is untouched — axe still walks every node and every violation
     * still fails the case — this is the ceiling the walk happens under.
     */
    testTimeout: 90_000,
  },
});
