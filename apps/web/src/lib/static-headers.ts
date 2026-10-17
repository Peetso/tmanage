import type { NextConfig } from 'next';

/**
 * PERF — explicit long-lived caching for content-hashed static assets.
 *
 * `21-REQUIREMENTS-TRACEABILITY` NFR-04 is about hot read latency, and the measured gap the
 * perf brief names is proof, not missing work; this rule is the one static-delivery lever that
 * is purely additive and cannot regress a read. Everything Next emits under `/_next/static`
 * carries a content hash in its name — the JavaScript chunks, the CSS, and the self-hosted
 * Manrope face `next/font/local` fingerprints into `/_next/static/media`. A hashed URL names
 * one immutable byte stream for all time, so it is safe to let a browser keep it for a year and
 * never revalidate: a new build ships a new hash, so a stale asset is never requested again.
 *
 * `max-age=31536000, immutable` is exactly that promise — one year, and `immutable` tells the
 * browser not to send a conditional request even on a hard reload. Next sets this itself on
 * `/_next/static` in a production server; stating it here keeps it true behind whatever proxy
 * `50-BOOTSTRAP` puts in front (the single-process Hostinger bundle included), where the
 * framework's own default would otherwise be the proxy's to strip.
 *
 * ## Why this is scoped to `/_next/static` and not `public/`
 *
 * Only fingerprinted URLs may be `immutable`. Files served from `public/` keep the name they
 * were authored with, so a one-year `immutable` on them would pin a stale favicon or manifest
 * past a deploy with no way for a client to notice. They are therefore deliberately left on the
 * default (revalidated) policy. HTML and the `/v1/*` API proxy are left out for the same
 * reason — a deploy must be visible on the next navigation, not a year later.
 */

/** One year in seconds, then `immutable`: the only correct policy for a content-hashed URL. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The path Next serves every content-hashed build asset (and `next/font/local` faces) under. */
export const STATIC_ASSET_SOURCE = '/_next/static/:path*';

type HeaderRule = Awaited<ReturnType<NonNullable<NextConfig['headers']>>>[number];

/**
 * The `headers()` rules that add {@link IMMUTABLE_CACHE_CONTROL} to the content-hashed static
 * assets, and to nothing else. Spread into `next.config.ts`'s `headers()` alongside the security
 * rule; Next applies the headers of every rule whose `source` matches, so a static asset keeps
 * the catch-all security headers and gains this one.
 */
export function staticAssetHeaderRules(): HeaderRule[] {
  return [
    {
      source: STATIC_ASSET_SOURCE,
      headers: [{ key: 'Cache-Control', value: IMMUTABLE_CACHE_CONTROL }],
    },
  ];
}
