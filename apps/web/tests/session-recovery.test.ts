import { describe, expect, it, vi } from 'vitest';
import {
  ApiClient,
  CSRF_HEADER,
  REFRESH_PATH,
  type SessionRecoveryOptions,
} from '../src/lib/api/client';
import { ApiRequestError, NetworkError } from '../src/lib/api/errors';
import { developmentSignIn, refreshSession, signOut } from '../src/lib/api/session';
import { signInWithPassword } from '../src/lib/api/auth';

/**
 * Review finding D04 (2026-09-05): the browser never invoked session refresh, so an access
 * token's 900 seconds were the whole session. Every case the report's acceptance names is
 * here, driven against a `fetch` this file supplies: expiry during a read, expiry before a
 * mutation, concurrent requests, concurrent tabs (the lock), a revoked refresh, and the clean
 * sign-out on a terminal failure. Plus D03's half that lives in the client: the token the API
 * returned is kept in memory and preferred over the cookie.
 *
 * Before this change `ApiClient` had no `recovery` option; a 401 was thrown to the screen
 * and the screen said "sign in again". Every test in the first block fails on that client.
 */

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly csrf: string | null;
}

const UNAUTHENTICATED = {
  error: { code: 'unauthenticated', message: 'Your session has ended.', correlationId: 'c' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A scripted API. `script` answers by path; `accessValid` flips to true when a refresh
 * succeeds, which is what the cookie jar would do in a browser.
 */
function apiWith(options: {
  refreshAnswers?: () => Response | Promise<Response>;
  recovery?: Partial<SessionRecoveryOptions> | false;
  csrfCookie?: string;
  expiredAtStart?: boolean;
}) {
  const calls: Recorded[] = [];
  let accessValid = !(options.expiredAtStart ?? true);
  const onSessionEnded = vi.fn();

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace('https://api.example.test', '');
    const method = init?.method ?? 'GET';
    calls.push({ path, method, csrf: new Headers(init?.headers).get(CSRF_HEADER) });

    if (path === REFRESH_PATH) {
      const answer = options.refreshAnswers
        ? await options.refreshAnswers()
        : json({ csrfToken: 'csrf-after-refresh', expiresAt: 'later' });
      if (answer.ok) accessValid = true;
      return answer;
    }
    if (path === '/v1/dev/sessions') {
      accessValid = true;
      return json({ csrfToken: 'csrf-from-sign-in', expiresAt: 'later' }, 201);
    }
    if (path === '/v1/auth/password') return json(UNAUTHENTICATED, 401);
    if (path === '/v1/sessions/current') {
      accessValid = false;
      return new Response(null, { status: 204 });
    }
    if (!accessValid) return json(UNAUTHENTICATED, 401);
    return json({ ok: true, path, method });
  });

  const recovery: SessionRecoveryOptions | undefined =
    options.recovery === false ? undefined : { onSessionEnded, ...options.recovery };

  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tmanage_session_csrf',
    fetch: fetch as unknown as typeof globalThis.fetch,
    readCsrfToken: () => options.csrfCookie,
    newCorrelationId: () => 'c',
    ...(recovery ? { recovery } : {}),
  });

  return { client, calls, onSessionEnded, fetch };
}

describe('recovering an expired access token', () => {
  it('refreshes once and replays a read that was refused', async () => {
    const { client, calls, onSessionEnded } = apiWith({ csrfCookie: 'cookie-token' });

    const { data } = await client.request<{ path: string }>({ path: '/v1/organizations' });

    expect(data.path).toBe('/v1/organizations');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/organizations',
      `POST ${REFRESH_PATH}`,
      'GET /v1/organizations',
    ]);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('sends the CSRF token on the refresh itself, which the API verifies inside the transaction', async () => {
    const { client, calls } = apiWith({ csrfCookie: 'cookie-token' });
    await client.request({ path: '/v1/organizations' });
    expect(calls[1]?.csrf).toBe('cookie-token');
  });

  it('replays a mutation refused before it ran, exactly once', async () => {
    const { client, calls } = apiWith({ csrfCookie: 'cookie-token' });

    const { data } = await client.request<{ method: string }>({
      method: 'POST',
      path: '/v1/organizations/x/work-items',
      body: { title: 'once' },
    });

    expect(data.method).toBe('POST');
    expect(calls.filter((call) => call.path.endsWith('/work-items'))).toHaveLength(2);
    expect(calls.filter((call) => call.path === REFRESH_PATH)).toHaveLength(1);
  });

  it('coalesces concurrent refusals onto one refresh', async () => {
    const { client, calls } = apiWith({ csrfCookie: 'cookie-token' });

    await Promise.all([
      client.request({ path: '/v1/a' }),
      client.request({ path: '/v1/b' }),
      client.request({ method: 'POST', path: '/v1/c', body: {} }),
    ]);

    expect(calls.filter((call) => call.path === REFRESH_PATH)).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/v1/a')).toHaveLength(2);
    expect(calls.filter((call) => call.path === '/v1/c')).toHaveLength(2);
  });

  it('takes the cross-tab lock around the refresh', async () => {
    const order: string[] = [];
    const lock: NonNullable<SessionRecoveryOptions['lock']> = async (work) => {
      order.push('lock');
      try {
        return await work();
      } finally {
        order.push('unlock');
      }
    };
    const { client, calls } = apiWith({ csrfCookie: 'cookie-token', recovery: { lock } });

    await client.request({ path: '/v1/organizations' });

    expect(order).toEqual(['lock', 'unlock']);
    expect(calls.filter((call) => call.path === REFRESH_PATH)).toHaveLength(1);
  });

  it('remembers the token the refresh returned and uses it for the replayed mutation', async () => {
    // No readable cookie at all — the API-on-another-host case (D03). The only token this
    // tab can echo is the one the API just returned.
    const { client, calls } = apiWith({});

    await client.request({ method: 'POST', path: '/v1/thing', body: {} });

    const [first, refresh, replay] = calls;
    expect(first?.csrf).toBeNull();
    expect(refresh?.path).toBe(REFRESH_PATH);
    expect(replay?.csrf).toBe('csrf-after-refresh');
  });

  it('does not loop when the replay is refused again', async () => {
    // A refresh that "succeeds" in shape while the access cookie it set is still refused —
    // a broken deployment. One refresh, one replay, then the refusal reaches the caller.
    const paths: string[] = [];
    const broken = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tmanage_session_csrf',
      fetch: (async (input: RequestInfo | URL) => {
        const path = String(input).replace('https://api.example.test', '');
        paths.push(path);
        return path === REFRESH_PATH
          ? json({ csrfToken: 'x', expiresAt: 'y' })
          : json(UNAUTHENTICATED, 401);
      }) as unknown as typeof globalThis.fetch,
      readCsrfToken: () => 'cookie-token',
      newCorrelationId: () => 'c',
      recovery: { onSessionEnded: vi.fn() },
    });

    const error = await broken.request({ path: '/v1/thing' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(paths).toEqual(['/v1/thing', REFRESH_PATH, '/v1/thing']);
  });
});

describe('ending the session', () => {
  it('reports a refused refresh once, forgets the token, and throws the original refusal', async () => {
    const { client, calls, onSessionEnded } = apiWith({
      csrfCookie: 'cookie-token',
      refreshAnswers: () => json(UNAUTHENTICATED, 401),
    });
    client.rememberCsrfToken('remembered');

    const errors = await Promise.all([
      client.request({ path: '/v1/a' }).catch((thrown: unknown) => thrown),
      client.request({ path: '/v1/b' }).catch((thrown: unknown) => thrown),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect((error as ApiRequestError).status).toBe(401);
    }
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(onSessionEnded).toHaveBeenCalledWith('refresh_refused');
    expect(calls.filter((call) => call.path === REFRESH_PATH)).toHaveLength(1);
    // Nothing was replayed after a terminal failure.
    expect(calls.filter((call) => call.path === '/v1/a')).toHaveLength(1);

    // The remembered token went with the session: the next mutation carries the cookie's.
    await client.request({ method: 'POST', path: '/v1/after', body: {} }).catch(() => undefined);
    expect(calls.at(-1)?.csrf).toBe('cookie-token');
  });

  it('does not end the session when the refresh could not reach the API', async () => {
    const { client, onSessionEnded } = apiWith({
      csrfCookie: 'cookie-token',
      refreshAnswers: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    const error = await client.request({ path: '/v1/a' }).catch((thrown: unknown) => thrown);

    // The original 401 is what the caller sees — not the network failure, which is the
    // refresh's, and not a silent sign-out over a dropped connection.
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('does not end the session on a refresh the API faulted on', async () => {
    const { client, onSessionEnded } = apiWith({
      csrfCookie: 'cookie-token',
      refreshAnswers: () =>
        json({ error: { code: 'internal_error', message: 'x', correlationId: 'c' } }, 500),
    });
    const error = await client.request({ path: '/v1/a' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });
});

describe('what never triggers a refresh', () => {
  it('a route that authenticates by something other than the session', async () => {
    const { client, calls, onSessionEnded } = apiWith({ csrfCookie: 'cookie-token' });

    const error = await signInWithPassword(client, {
      email: 'a@example.test',
      password: 'wrong',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(calls.map((call) => call.path)).toEqual(['/v1/auth/password']);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('the refresh route itself', async () => {
    const { client, calls, onSessionEnded } = apiWith({
      csrfCookie: 'cookie-token',
      refreshAnswers: () => json(UNAUTHENTICATED, 401),
    });

    const error = await refreshSession(client).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(calls).toHaveLength(1);
    // A deliberate refresh that is refused is the caller's to handle; the automatic path is
    // the one that reports the end of the session.
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a client built without recovery', async () => {
    const { client, calls } = apiWith({ csrfCookie: 'cookie-token', recovery: false });
    const error = await client.request({ path: '/v1/a' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(calls).toHaveLength(1);
  });

  it('a refusal that is not about the session', async () => {
    const forbidden = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tmanage_session_csrf',
      fetch: (async () =>
        json(
          { error: { code: 'forbidden', message: 'no', correlationId: 'c' } },
          403,
        )) as unknown as typeof globalThis.fetch,
      readCsrfToken: () => 'cookie-token',
      newCorrelationId: () => 'c',
      recovery: { onSessionEnded: vi.fn() },
    });
    const error = await forbidden.request({ path: '/v1/a' }).catch((thrown: unknown) => thrown);
    expect((error as ApiRequestError).code).toBe('forbidden');
  });

  it('a request that never arrived', async () => {
    const offline = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tmanage_session_csrf',
      fetch: (() =>
        Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch,
      readCsrfToken: () => 'cookie-token',
      newCorrelationId: () => 'c',
      recovery: { onSessionEnded: vi.fn() },
    });
    const error = await offline
      .request({ method: 'POST', path: '/v1/a', body: {} })
      .catch((thrown: unknown) => thrown);
    // Ambiguous outcome: the write may have landed. Never replayed.
    expect(error).toBeInstanceOf(NetworkError);
  });
});

describe('the CSRF token in memory (D03)', () => {
  it('is kept from sign-in and preferred over the cookie', async () => {
    const { client, calls } = apiWith({ csrfCookie: 'cookie-token', expiredAtStart: false });

    await developmentSignIn(client, 'user-1');
    await client.request({ method: 'POST', path: '/v1/thing', body: {} });

    expect(calls.at(-1)?.csrf).toBe('csrf-from-sign-in');
  });

  it('is dropped by sign-out, so the next mutation falls back to whatever cookie is readable', async () => {
    // No recovery here: the scripted API refuses everything after the sign-out, and a refresh
    // would put a new token in memory — the wrong thing to be measuring.
    const { client, calls } = apiWith({
      csrfCookie: 'cookie-token',
      expiredAtStart: false,
      recovery: false,
    });

    await developmentSignIn(client, 'user-1');
    await signOut(client);
    await client.request({ method: 'POST', path: '/v1/thing', body: {} }).catch(() => undefined);

    expect(calls.at(-1)?.csrf).toBe('cookie-token');
  });

  it('is dropped by sign-out even when the sign-out request never arrived', async () => {
    const sent: (string | null)[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tmanage_session_csrf',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') throw new TypeError('Failed to fetch');
        sent.push(new Headers(init?.headers).get(CSRF_HEADER));
        return json({});
      }) as unknown as typeof globalThis.fetch,
      readCsrfToken: () => 'cookie-token',
      newCorrelationId: () => 'c',
    });
    client.rememberCsrfToken('remembered');

    await expect(signOut(client)).rejects.toBeInstanceOf(NetworkError);
    await client.request({ method: 'POST', path: '/v1/thing', body: {} });

    expect(sent).toEqual(['cookie-token']);
  });
});
