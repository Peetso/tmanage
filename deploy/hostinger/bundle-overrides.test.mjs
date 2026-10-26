// Run: node --test deploy/hostinger/bundle-overrides.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { npmOverridesFromRoot } from './bundle-overrides.mjs';

const RUNTIME = ['fastify', 'fast-uri', '@nestjs/platform-fastify'];

test('copies plain runtime keys, keeps selector keys (NV08 run 2) and skips dev-only keys', () => {
  const rootPkg = {
    pnpm: {
      overrides: {
        fastify: '5.3.3',
        '@nestjs/platform-fastify': '11.1.6',
        'fast-uri@>=4 <4.1.5': '4.1.5',
        tinypool: '1.1.1',
      },
    },
  };
  assert.deepEqual(npmOverridesFromRoot(rootPkg, RUNTIME), {
    fastify: '5.3.3',
    '@nestjs/platform-fastify': '11.1.6',
    'fast-uri@>=4 <4.1.5': '4.1.5',
  });
});

test('returns {} when pnpm.overrides is empty or missing', () => {
  assert.deepEqual(npmOverridesFromRoot({ pnpm: { overrides: {} } }, RUNTIME), {});
  assert.deepEqual(npmOverridesFromRoot({}, RUNTIME), {});
});
