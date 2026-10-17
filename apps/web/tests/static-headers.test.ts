import { describe, expect, it } from 'vitest';
import {
  IMMUTABLE_CACHE_CONTROL,
  STATIC_ASSET_SOURCE,
  staticAssetHeaderRules,
} from '../src/lib/static-headers';

/**
 * PERF — the static-asset caching rule, asserted as a value rather than as a comment.
 *
 * The regression this guards is a deploy that silently drops the long-lived `Cache-Control`
 * off the content-hashed assets (a proxy rewrite, a refactor of `headers()`), or — worse —
 * one that extends `immutable` onto a path that is not fingerprinted and pins a stale asset for
 * a year. So the test asserts both halves: the hashed path is immutable for exactly a year, and
 * no catch-all/HTML path carries the policy.
 */
describe('static asset cache headers', () => {
  it('caches hashed /_next/static assets as public, immutable, for a year', () => {
    const rule = staticAssetHeaderRules().find(
      (candidate) => candidate.source === STATIC_ASSET_SOURCE,
    );
    expect(rule, 'a rule for the hashed static path must be present').toBeDefined();

    const cacheControl = rule?.headers.find((header) => header.key === 'Cache-Control');
    expect(cacheControl?.value).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControl?.value).toContain('immutable');
    expect(cacheControl?.value).toContain('max-age=31536000');
    expect(cacheControl?.value).toContain('public');
  });

  it('names only the hashed static path — never the catch-all HTML path', () => {
    const sources = staticAssetHeaderRules().map((rule) => rule.source);
    expect(sources).toEqual([STATIC_ASSET_SOURCE]);
    // The catch-all `/:path*` (HTML, and the `/v1/*` API proxy) must not be cached here: a
    // deploy has to be visible on the next navigation, not a year later.
    expect(sources).not.toContain('/:path*');
    expect(sources).not.toContain('/');
    for (const rule of staticAssetHeaderRules()) {
      expect(rule.source.startsWith('/_next/static')).toBe(true);
    }
  });
});
