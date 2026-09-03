import { defineConfig } from 'vitest/config';

/** The port's own suite: the key builder and the fake driver. Pure, node, no network. */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
