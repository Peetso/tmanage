import { expect, it } from 'vitest';
import { ApiClient, REFRESH_PATH } from '../src/lib/api/client';

/** R3 — only real activity refreshes: a background poll cannot keep an idle session alive. */
it('refreshes an expired request only after activity since the last refresh', async () => {
  const urls: string[] = [];
  let clock = 0;
  const client = new ApiClient({
    baseUrl: '',
    csrfCookieName: 'c',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'id',
    now: () => clock,
    recovery: { onSessionEnded: () => undefined, requireActivity: true },
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const ok = String(input) === REFRESH_PATH;
      return new Response(JSON.stringify(ok ? {} : { code: 'unauthenticated' }), {
        status: ok ? 200 : 401,
      });
    }) as typeof fetch,
  });
  const refreshes = () => urls.filter((url) => url === REFRESH_PATH).length;
  await client.request({ path: '/poll' }).catch(() => undefined); // page load counts as activity
  clock = 60_000;
  await client.request({ path: '/poll' }).catch(() => undefined); // background: no refresh
  expect(refreshes()).toBe(1);
  client.noteActivity();
  await client.request({ path: '/poll' }).catch(() => undefined);
  expect(refreshes()).toBe(2);
});
