import { describe, expect, it, vi } from 'vitest';
import { ApiClient, CORRELATION_HEADER, CSRF_HEADER, readCookie } from '../src/lib/api/client';
import { ApiRequestError, NetworkError } from '../src/lib/api/errors';

/**
 * The API client is where three security controls either happen on every request or happen
 * by accident. Each one is asserted here against a `fetch` this test supplies, so the
 * assertions are about the request that was actually built rather than about the code that
 * builds it.
 */

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function clientWith(
  respond: (recorded: Recorded) => Response,
  options: { csrfToken?: string } = {},
): { client: ApiClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const recorded = { url: String(input), init: init ?? {} };
      calls.push(recorded);
      return Promise.resolve(respond(recorded));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => options.csrfToken,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('cookies', () => {
  it('matches a cookie by its exact name, not by prefix', () => {
    const header = 'tm_session_csrf_other=wrong; tm_session_csrf=right; other=no';
    expect(readCookie(header, 'tm_session_csrf')).toBe('right');
  });

  it('decodes a percent-encoded value', () => {
    expect(readCookie('a=one%20two', 'a')).toBe('one two');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(readCookie('b=1', 'a')).toBeUndefined();
  });
});

describe('every request', () => {
  it('sends credentials, so the session cookies reach another origin', async () => {
    const { client, calls } = clientWith(() => json({ ok: true }));
    await client.request({ path: '/v1/thing' });
    expect(calls[0]?.init.credentials).toBe('include');
  });

  it('carries a correlation id', async () => {
    const { client, calls } = clientWith(() => json({ ok: true }));
    await client.request({ path: '/v1/thing' });
    expect(headerOf(calls[0]!.init, CORRELATION_HEADER)).toBe('correlation-fixed');
  });

  it('prefers the correlation id the server echoed', async () => {
    const { client } = clientWith(() =>
      json({ ok: true }, 200, { [CORRELATION_HEADER]: 'from-server' }),
    );
    const response = await client.request({ path: '/v1/thing' });
    expect(response.correlationId).toBe('from-server');
  });
});

describe('CSRF', () => {
  it('sends the token on a mutation', async () => {
    const { client, calls } = clientWith(() => json({ ok: true }), { csrfToken: 'token-abc' });
    await client.request({ method: 'POST', path: '/v1/thing', body: {} });
    expect(headerOf(calls[0]!.init, CSRF_HEADER)).toBe('token-abc');
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not send the token on %s', async (method) => {
    const { client, calls } = clientWith(() => json({ ok: true }), { csrfToken: 'token-abc' });
    await client.request({ method, path: '/v1/thing' });
    expect(headerOf(calls[0]!.init, CSRF_HEADER)).toBeNull();
  });

  it('omits the header entirely when no token is readable', async () => {
    const { client, calls } = clientWith(() => json({ ok: true }));
    await client.request({ method: 'DELETE', path: '/v1/thing' });
    expect(headerOf(calls[0]!.init, CSRF_HEADER)).toBeNull();
  });
});

describe('refusals', () => {
  it('raises the envelope the API sent', async () => {
    const { client } = clientWith(() =>
      json(
        {
          error: {
            code: 'forbidden',
            message: 'You do not have access to this.',
            correlationId: 'abc',
            details: [{ field: 'slug', message: 'unknown' }],
          },
        },
        403,
      ),
    );

    const error = await client.request({ path: '/v1/thing' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiRequestError);
    const apiError = error as ApiRequestError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe('forbidden');
    expect(apiError.correlationId).toBe('abc');
    expect(apiError.fieldErrors().get('slug')).toBe('unknown');
  });

  it('derives a code and a message when a proxy answers with HTML', async () => {
    const { client } = clientWith(
      () =>
        new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    );

    const error = (await client
      .request({ path: '/v1/thing' })
      .catch((thrown: unknown) => thrown)) as ApiRequestError;

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.code).toBe('internal_error');
    expect(error.message).toContain('Try again');
  });

  it('ignores a code the API could not have sent', async () => {
    const { client } = clientWith(() =>
      json({ error: { code: 'you-are-not-an-admin', message: 'x', correlationId: 'y' } }, 403),
    );
    const error = (await client
      .request({ path: '/v1/thing' })
      .catch((thrown: unknown) => thrown)) as ApiRequestError;
    expect(error.code).toBe('forbidden');
  });

  it('drops malformed field details rather than rendering undefined', async () => {
    const { client } = clientWith(() =>
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'no',
            correlationId: 'y',
            details: [{ field: 'a', message: 'b' }, { field: 7 }, 'nonsense'],
          },
        },
        422,
      ),
    );
    const error = (await client
      .request({ path: '/v1/thing' })
      .catch((thrown: unknown) => thrown)) as ApiRequestError;
    expect(error.details).toEqual([{ field: 'a', message: 'b' }]);
  });

  it('keeps the first message when a field appears twice', async () => {
    const { client } = clientWith(() =>
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'no',
            correlationId: 'y',
            details: [
              { field: 'a', message: 'first' },
              { field: 'a', message: 'second' },
            ],
          },
        },
        422,
      ),
    );
    const error = (await client
      .request({ path: '/v1/thing' })
      .catch((thrown: unknown) => thrown)) as ApiRequestError;
    expect(error.fieldErrors().get('a')).toBe('first');
  });
});

describe('transport', () => {
  it('distinguishes a request that never arrived from one that was refused', async () => {
    const failing = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });

    const error = await failing.request({ path: '/v1/thing' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ApiRequestError);
  });

  it('returns undefined data for 204 rather than trying to parse a body', async () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    const response = await client.request<void>({ method: 'DELETE', path: '/v1/sessions/current' });
    expect(response.data).toBeUndefined();
  });
});
