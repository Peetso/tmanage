import { defineConfig } from 'vitest/config';

/**
 * The component harness UI-001 asks for.
 *
 * `jsdom` rather than a browser: this repository has no container runtime and no
 * downloadable browser budget, and the checks that genuinely need real layout — colour
 * contrast, 200% zoom, screen-reader output — are either computed from the tokens
 * directly (see `tests/contrast.test.ts`) or recorded as open human-validation items in
 * `docs/implementation-status.md`. What jsdom can prove, it proves here; what it cannot
 * is named rather than implied.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
