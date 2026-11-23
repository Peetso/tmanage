import { expect, it } from 'vitest';
import { ApiClient, IDLE_MINUTES_HEADER, REFRESH_PATH } from '../src/lib/api/client';

/**
 * A client whose `/tenant` answers 200 with the given idle limit (the tenant guard's header) and
 * whose `/poll` answers 401 `unauthenticated` (the access token has gone).
 */
function harness(limitMinutes: number) {
  const urls: string[] = [];
  const clock = { now: 0 };
  const client = new ApiClient({
    baseUrl: '',
    csrfCookieName: 'c',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'id',
    now: () => clock.now,
    recovery: { onSessionEnded: () => undefined, requireActivity: true },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === '/tenant') {
        return new Response('{}', {
          status: 200,
          headers: { [IDLE_MINUTES_HEADER]: String(limitMinutes) },
        });
      }
      const ok = url === REFRESH_PATH;
      return new Response(JSON.stringify(ok ? {} : { code: 'unauthenticated' }), {
        status: ok ? 200 : 401,
      });
    }) as typeof fetch,
  });
  const refreshes = () => urls.filter((url) => url === REFRESH_PATH).length;
  return { client, clock, refreshes };
}

/** R3 — only real activity refreshes: a background poll cannot keep an idle session alive. */
it('with an idle limit in force, refreshes an expired request only after activity', async () => {
  const { client, clock, refreshes } = harness(480);
  await client.request({ path: '/tenant' });
  await client.request({ path: '/poll' }).catch(() => undefined); // page load counts as activity
  clock.now = 60_000;
  await client.request({ path: '/poll' }).catch(() => undefined); // background: no refresh
  expect(refreshes()).toBe(1);
  client.noteActivity();
  await client.request({ path: '/poll' }).catch(() => undefined);
  expect(refreshes()).toBe(2);
});

/**
 * F4 — with the limit Off there is no idle rule to protect. Before the fix the second expiry of a
 * page used without a key or pointer event stayed refused ("The request carries no valid
 * session" on every card) until a reload.
 */
it('with the idle limit Off, refreshes every expired request', async () => {
  const { client, clock, refreshes } = harness(0);
  await client.request({ path: '/tenant' });
  await client.request({ path: '/poll' }).catch(() => undefined);
  clock.now = 16 * 60_000;
  await client.request({ path: '/poll' }).catch(() => undefined);
  expect(refreshes()).toBe(2);
});

/** F4 — the application is told each kept refresh, so it can re-run the refused reads. */
it('tells its listeners when a refresh kept the session, and only then', async () => {
  const { client, refreshes } = harness(0);
  let kept = 0;
  const stop = client.subscribeSessionKept(() => {
    kept += 1;
    throw new Error('a listener failure does not undo the refresh');
  });
  expect(await client.staySignedIn()).toBe(true);
  expect(kept).toBe(1);
  stop();
  await client.staySignedIn();
  expect(kept).toBe(1);
  expect(refreshes()).toBe(2);
});
