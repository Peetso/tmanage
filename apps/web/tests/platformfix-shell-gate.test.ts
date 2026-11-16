import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { stepUpWindow } from '../src/components/platform/shared/platform-kit';
import { safeReturnPath } from '../src/lib/sign-in-return';
import { signedOutAreaRedirect } from '../src/lib/signed-in-shell-gate';
import { proxy } from '../src/proxy';

const ORIGIN = 'https://tmanage.peetrix.com';

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } });
}

/**
 * PLATFORMFIX (live 2026-11-16): signed out, `/platform` showed the Platform admin shell and its
 * menu before the browser moved to sign-in. The server now answers with a redirect first.
 */
describe('a signed-out request for a signed-in area', () => {
  it('is a 307 to sign-in with no page body, for /platform and every page under it', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    const answers = await Promise.all(
      ['/platform', '/platform/organizations', '/organizations', '/sessions'].map(async (path) => {
        const response = proxy(request(path));
        return [
          path,
          response.status,
          response.headers.get('location'),
          (await response.text()).includes('Overview'),
        ];
      }),
    );
    expect(answers).toEqual([
      ['/platform', 307, `${ORIGIN}/sign-in?next=%2Fplatform`, false],
      ['/platform/organizations', 307, `${ORIGIN}/sign-in?next=%2Fplatform%2Forganizations`, false],
      ['/organizations', 307, `${ORIGIN}/sign-in`, false],
      ['/sessions', 307, `${ORIGIN}/sign-in`, false],
    ]);
  });

  it('lets a request with a session through (membership is the server check, then the API)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'same-origin');
    const response = proxy(request('/platform', 'tmanage_session_csrf=x'));
    expect([response.status, response.headers.get('location')]).toEqual([200, null]);
  });

  it('matches whole segments only and returns only to a plain platform path', () => {
    expect(
      ['/platformx', '/platforms/a', '/x/platform', '/platform/a'].map((path) =>
        signedOutAreaRedirect(path, false),
      ),
    ).toEqual([undefined, undefined, undefined, '/sign-in?next=%2Fplatform%2Fa']);
    expect(
      ['/platform/team', '/platform/a.b', '//evil.com', '/platform/../x'].map(safeReturnPath),
    ).toEqual(['/platform/team', '/organizations', '/organizations', '/organizations']);
  });
});

describe('the step-up window on screen', () => {
  it('reads 24 hours for the default, minutes for anything not a whole number of hours', () => {
    expect([1440, 60, 480, 15, 90].map(stepUpWindow)).toEqual([
      { count: 24, hours: true },
      { count: 1, hours: true },
      { count: 8, hours: true },
      { count: 15, hours: false },
      { count: 90, hours: false },
    ]);
  });
});
