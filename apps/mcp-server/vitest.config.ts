import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. The tool handlers are exercised against a mocked API client and the HTTP
 * client against a mocked `fetch`, so nothing here needs a live TManage server — the real
 * end-to-end path (a token, the API, the seven tools) is a manual check documented in the
 * README.
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
