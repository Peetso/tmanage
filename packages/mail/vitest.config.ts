import { defineConfig } from 'vitest/config';

/**
 * The drivers' own suites. `smtp-mailer.test.ts` scripts a real SMTP conversation over a
 * local socket, so this runs in the node environment and nowhere near jsdom.
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
