import { SESSION_COOKIE_NAME_DEFAULT } from '@tmanage/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl, csrfCookieName, resetBrowserApiClient } from '../src/lib/api/browser-client';
import { REFRESH_PATH } from '../src/lib/api/client';
import {
  DEFAULT_SESSION_COOKIE_NAME,
  DEVELOPMENT_API_BASE_URL,
  PublicConfigError,
  SAME_ORIGIN,
  resolveApiBaseUrl,
  resolveApiRewrites,
  resolveCsrfCookieName,
  validatePublicConfigForBuild,
  type PublicEnvironment,
} from '../src/lib/public-config';

/**
 * Review findings D02, D03 and D19 (2026-09-05), each with the failure it names:
 *
 * - D02: the browser's default CSRF cookie name disagreed with the API's. The default is now
 *   held equal to `packages/config`'s — by import, so a change to either side fails here.
 * - D19: a production build with no API origin compiled `localhost:3001` into the bundle. It
 *   now refuses to build.
 * - D03: the same-origin topology's rewrite must preserve the exact `/v1` path, because the
 *   API scopes its refresh cookie to `/v1/sessions/refresh`.
 */

function env(overrides: Partial<PublicEnvironment> = {}): PublicEnvironment {
  return {
    nodeEnv: 'production',
    apiBaseUrl: undefined,
    sessionCookieName: undefined,
    ...overrides,
  };
}

describe('the CSRF cookie name (D02)', () => {
  it('defaults to the same session cookie name as packages/config', () => {
    expect(DEFAULT_SESSION_COOKIE_NAME).toBe(SESSION_COOKIE_NAME_DEFAULT);
  });

  it('derives the readable cookie exactly as the API does', () => {
    expect(resolveCsrfCookieName(env())).toBe(`${SESSION_COOKIE_NAME_DEFAULT}_csrf`);
    expect(resolveCsrfCookieName(env({ sessionCookieName: 'other' }))).toBe('other_csrf');
    expect(resolveCsrfCookieName(env({ sessionCookieName: '  ' }))).toBe(
      `${SESSION_COOKIE_NAME_DEFAULT}_csrf`,
    );
  });
});

describe('the API base URL in development', () => {
  it('defaults to the local API when nothing is set', () => {
    expect(resolveApiBaseUrl(env({ nodeEnv: 'development' }))).toBe(DEVELOPMENT_API_BASE_URL);
    expect(resolveApiBaseUrl(env({ nodeEnv: 'test' }))).toBe(DEVELOPMENT_API_BASE_URL);
    expect(resolveApiBaseUrl(env({ nodeEnv: undefined }))).toBe(DEVELOPMENT_API_BASE_URL);
  });

  it('accepts a plain-http origin and drops a trailing slash', () => {
    expect(
      resolveApiBaseUrl(env({ nodeEnv: 'development', apiBaseUrl: 'http://localhost:3101/' })),
    ).toBe('http://localhost:3101');
  });

  it('accepts same-origin', () => {
    expect(resolveApiBaseUrl(env({ nodeEnv: 'development', apiBaseUrl: SAME_ORIGIN }))).toBe('');
  });
});

describe('the API base URL in a production build (D19)', () => {
  it('refuses to build when the variable is absent, naming it', () => {
    expect(() => resolveApiBaseUrl(env())).toThrowError(PublicConfigError);
    expect(() => resolveApiBaseUrl(env({ apiBaseUrl: '' }))).toThrowError(
      /NEXT_PUBLIC_API_BASE_URL is not set/,
    );
  });

  it.each([
    ['http://api.example.com', /must use https/],
    ['https://localhost:3001', /loopback/],
    ['https://127.0.0.1', /loopback/],
    ['https://api.localhost', /loopback/],
    ['api.example.com', /not an absolute URL/],
    ['https://api.example.com/api', /origin only/],
    ['https://api.example.com/?x=1', /origin only/],
    ['ftp://api.example.com', /only http and https/],
  ])('refuses %s', (value, message) => {
    expect(() => resolveApiBaseUrl(env({ apiBaseUrl: value }))).toThrowError(message);
  });

  it('accepts an https origin and normalises it', () => {
    expect(resolveApiBaseUrl(env({ apiBaseUrl: 'https://api.example.com/' }))).toBe(
      'https://api.example.com',
    );
    expect(resolveApiBaseUrl(env({ apiBaseUrl: ' https://API.example.com ' }))).toBe(
      'https://api.example.com',
    );
  });

  it('accepts same-origin', () => {
    expect(resolveApiBaseUrl(env({ apiBaseUrl: SAME_ORIGIN }))).toBe('');
  });
});

describe('the same-origin rewrite (D03)', () => {
  it('is absent when the API has its own origin and no proxy target is set', () => {
    expect(resolveApiRewrites(env({ apiBaseUrl: 'https://api.example.com' }))).toEqual([]);
    expect(resolveApiRewrites(env({ nodeEnv: 'development' }))).toEqual([]);
  });

  it('forwards /v1 to the target under the identical path, so the refresh cookie path survives', () => {
    const [rewrite, ...rest] = resolveApiRewrites(
      env({ apiBaseUrl: SAME_ORIGIN, apiProxyTarget: 'https://api.internal.example.com/' }),
    );
    expect(rest).toEqual([]);
    expect(rewrite).toEqual({
      source: '/v1/:path*',
      destination: 'https://api.internal.example.com/v1/:path*',
    });

    // The exact browser path of a refresh, put through the pattern by hand.
    const forwarded = rewrite!.destination.replace('/:path*', REFRESH_PATH.slice('/v1'.length));
    expect(forwarded).toBe(`https://api.internal.example.com${REFRESH_PATH}`);
  });

  it('refuses same-origin with no target, naming both variables', () => {
    expect(() => resolveApiRewrites(env({ apiBaseUrl: SAME_ORIGIN }))).toThrowError(
      /API_PROXY_TARGET is not set/,
    );
  });

  it('refuses a target that is set while the browser dials the API directly', () => {
    expect(() =>
      resolveApiRewrites(
        env({ apiBaseUrl: 'https://api.example.com', apiProxyTarget: 'https://api.internal' }),
      ),
    ).toThrowError(/set both or neither/);
  });

  it('holds a target on another host to https, and lets a loopback target be plain http', () => {
    expect(() =>
      resolveApiRewrites(env({ apiBaseUrl: SAME_ORIGIN, apiProxyTarget: 'http://api.internal' })),
    ).toThrowError(/over https/);
    // The API on the web server's own machine — the value `.env.example` documents. The
    // first live `next build` witness (2026-09-06) found this refused under the browser's
    // rule; the server-side hop never leaves the machine and needs no TLS.
    expect(
      resolveApiRewrites(env({ apiBaseUrl: SAME_ORIGIN, apiProxyTarget: 'http://127.0.0.1:4000' })),
    ).toEqual([{ source: '/v1/:path*', destination: 'http://127.0.0.1:4000/v1/:path*' }]);
    expect(
      resolveApiRewrites(env({ apiBaseUrl: SAME_ORIGIN, apiProxyTarget: 'http://localhost:4000' })),
    ).toEqual([{ source: '/v1/:path*', destination: 'http://localhost:4000/v1/:path*' }]);
    // In development a plain-http target on the developer's own machine is the normal case.
    expect(
      resolveApiRewrites(
        env({
          nodeEnv: 'development',
          apiBaseUrl: SAME_ORIGIN,
          apiProxyTarget: 'http://localhost:3001',
        }),
      ),
    ).toEqual([{ source: '/v1/:path*', destination: 'http://localhost:3001/v1/:path*' }]);
  });
});

describe('the build-time validation next.config.ts runs', () => {
  it('returns everything the config needs for a valid same-origin production build', () => {
    expect(
      validatePublicConfigForBuild(
        env({ apiBaseUrl: SAME_ORIGIN, apiProxyTarget: 'https://api.internal.example.com' }),
      ),
    ).toEqual({
      apiBaseUrl: '',
      csrfCookieName: `${SESSION_COOKIE_NAME_DEFAULT}_csrf`,
      rewrites: [
        { source: '/v1/:path*', destination: 'https://api.internal.example.com/v1/:path*' },
      ],
    });
  });

  it('fails a production build with nothing set', () => {
    expect(() => validatePublicConfigForBuild(env())).toThrowError(PublicConfigError);
  });
});

/**
 * The browser-side readers, through the real `process.env`. These are the functions the
 * review's probe called; before this change `csrfCookieName()` answered `tm_session_csrf`
 * with nothing set and `apiBaseUrl()` answered `http://localhost:3001` under `production`.
 */
describe('the browser readers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetBrowserApiClient();
  });

  it('read the server default cookie name when no override is set', () => {
    vi.stubEnv('NEXT_PUBLIC_SESSION_COOKIE_NAME', '');
    expect(csrfCookieName()).toBe(`${SESSION_COOKIE_NAME_DEFAULT}_csrf`);
  });

  it('refuse a production build with no API origin instead of dialing localhost', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '');
    expect(() => apiBaseUrl()).toThrowError(/NEXT_PUBLIC_API_BASE_URL is not set/);
  });

  it('keep the development default where a developer expects it', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '');
    expect(apiBaseUrl()).toBe(DEVELOPMENT_API_BASE_URL);
  });
});
