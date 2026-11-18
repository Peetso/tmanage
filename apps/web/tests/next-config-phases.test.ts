import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants.js';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { catalogVersion } from '../src/lib/i18n/catalog-version';

/**
 * `next.config.ts` is loaded again by `next start`, from a directory with the build and none of
 * the sources (the 2026-11-18 Hostinger crash loop). Build-time inputs are therefore read only in
 * the compiling phases; the bundle-side proof is `deploy/hostinger/next-config-mjs.test.mjs`.
 */
describe('next.config phases', () => {
  const i18nDir = join(process.cwd(), 'src', 'lib', 'i18n');

  it.each([PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER])(
    '%s inlines the catalog version hashed from the catalog sources',
    (phase) => {
      expect(nextConfig(phase).env?.['NEXT_PUBLIC_CATALOG_VERSION']).toBe(catalogVersion(i18nDir));
    },
  );

  it('the production server leaves it out: the build already inlined it', () => {
    const env = nextConfig(PHASE_PRODUCTION_SERVER).env ?? {};
    expect(env).not.toHaveProperty('NEXT_PUBLIC_CATALOG_VERSION');
    expect(env['NEXT_PUBLIC_SIGNUP']).toBe(
      nextConfig(PHASE_PRODUCTION_BUILD).env?.['NEXT_PUBLIC_SIGNUP'],
    );
  });
});
