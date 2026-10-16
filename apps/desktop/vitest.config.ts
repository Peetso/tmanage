import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the desktop companion's pure policy modules (deep-link routing and the
 * navigation / external-link guard). These never import Electron, so they run in a plain
 * Node environment with no display or app binary.
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
