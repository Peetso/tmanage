import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { languageSwitchTarget } from '../src/lib/i18n/public-locale-routes';
import { proxy } from '../src/proxy';

const ORIGIN = 'https://tmanageapp.com';
const ARABIC = 'tmanage_locale=ar-EG';

function answer(path: string, init: { cookie?: string; accept?: string; method?: string } = {}) {
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.accept !== undefined) headers['accept'] = init.accept;
  const response = proxy(
    new NextRequest(`${ORIGIN}${path}`, { headers, method: init.method ?? 'GET' }),
  );
  return { status: response.status, location: response.headers.get('location'), response };
}

/**
 * LIVEFIX (live 3760a1a6, 2026-11-18): a visitor whose saved language is Arabic opened `/pricing`,
 * `/sign-in` or `/verify` and read English laid out right to left for 3–5 s, until the Arabic
 * catalog arrived. The server now sends such a request to the Arabic twin, prerendered in Arabic,
 * before any HTML is served.
 */
describe('a saved-Arabic visitor on an English public address', () => {
  it('is a 307 to the Arabic twin, keeping the query, for website, auth and verify pages', () => {
    expect(
      ['/pricing', '/', '/sign-in?next=%2Fhome', '/verify?id=abc', '/help'].map((path) => {
        const { status, location } = answer(path, { cookie: `a=1; ${ARABIC}` });
        return [path, status, location];
      }),
    ).toEqual([
      ['/pricing', 307, `${ORIGIN}/ar/pricing`],
      ['/', 307, `${ORIGIN}/ar`],
      ['/sign-in?next=%2Fhome', 307, `${ORIGIN}/ar/sign-in?next=%2Fhome`],
      ['/verify?id=abc', 307, `${ORIGIN}/ar/verify?id=abc`],
      ['/help', 307, `${ORIGIN}/ar/help`],
    ]);
  });

  it('is never kept by a shared cache for another visitor', () => {
    const { response } = answer('/pricing', { cookie: ARABIC });
    expect([response.headers.get('cache-control'), response.headers.get('vary')]).toEqual([
      'private, no-store',
      'Cookie',
    ]);
  });

  it('follows `?lang=` over the cookie, as the boot script does, and drops it from the target', () => {
    expect([
      answer('/pricing?lang=en', { cookie: ARABIC }).location,
      answer('/pricing?lang=ar&tab=faq').location,
    ]).toEqual([null, `${ORIGIN}/ar/pricing?tab=faq`]);
  });

  it('leaves every other request where it is', () => {
    expect(
      [
        answer('/pricing'),
        answer('/pricing', { cookie: 'tmanage_locale=en-US' }),
        answer('/pricing', { cookie: 'tmanage_locale=ur-PK' }),
        answer('/ar/pricing', { cookie: ARABIC }),
        answer('/recover', { cookie: ARABIC }),
        answer('/pricing', { cookie: ARABIC, accept: 'text/markdown' }),
        answer('/pricing', { cookie: ARABIC, method: 'POST' }),
      ].map(({ status, location }) => [status, location]),
    ).toEqual(Array.from({ length: 7 }, () => [200, null]));
  });
});

describe('the unlisted Arabic page /ar/verify', () => {
  it('is where the language switch goes from /verify and back, keeping the query', () => {
    expect([
      languageSwitchTarget('/verify', true, '?id=abc'),
      languageSwitchTarget('/ar/verify', false),
    ]).toEqual(['/ar/verify?id=abc', '/verify']);
  });
});
