import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. The relay's database proof — claiming, publishing, backoff, parking,
 * the lifecycle consumer against real rows — lives in
 * `apps/api/test/plat-004-relay.db.test.ts`, which reuses the API suite's embedded MySQL
 * harness rather than duplicating it here (one server download, one migration path, one
 * `truncateAll`). What runs here is the pure half: backoff arithmetic and the state
 * mapping, the parts a fake database would prove nothing extra about.
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
