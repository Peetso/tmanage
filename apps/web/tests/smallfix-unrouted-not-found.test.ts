import { describe, expect, it } from 'vitest';
import { createUnroutedNotFound } from '../src/lib/unrouted-not-found';

/**
 * SMALLFIX 4 (live 2026-11-17): `/confirm-email` answered 404 with a white page — a request-time
 * not-found render draws its screen from a runtime chunk that Trusted Types refuses. Every
 * address no route takes is now answered with the prerendered not-found page, signed in or out.
 */
const MANIFEST = JSON.stringify({
  staticRoutes: [
    { page: '/', regex: '^/(?:/)?$' },
    { page: '/_not-found', regex: '^/_not\\-found(?:/)?$' },
    { page: '/pricing', regex: '^/pricing(?:/)?$' },
  ],
  dynamicRoutes: [
    { page: '/confirm-email/[token]', regex: '^/confirm\\-email/([^/]+?)(?:/)?$' },
    { page: '/[orgSlug]', regex: '^/([^/]+?)(?:/)?$' },
    { page: '/[orgSlug]/home', regex: '^/([^/]+?)/home(?:/)?$' },
  ],
});

describe('an address no route takes', () => {
  it('is answered with the prerendered not-found page; real routes are left alone', () => {
    const notFound = createUnroutedNotFound('/dist', () => MANIFEST);
    expect(
      [
        '/confirm-email',
        '/confirm-email/TOKEN/extra',
        '/nile-studio/no-such-page',
        '/confirm-email/TOKEN',
        '/pricing',
        '/nile-studio',
        '/nile-studio/home',
      ].map(notFound),
    ).toEqual([
      '/_not-found',
      '/_not-found',
      '/_not-found',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('changes nothing without a build manifest (next dev)', () => {
    const notFound = createUnroutedNotFound('/dist', () => {
      throw new Error('ENOENT');
    });
    expect(notFound('/confirm-email')).toBeUndefined();
  });
});
