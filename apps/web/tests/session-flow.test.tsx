import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SessionsScreen } from '../src/components/screens/SessionsScreen';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * The two screens that talk to the API.
 *
 * Each one is driven against an `ApiClient` built over a `fetch` this file supplies, so the
 * assertions are about what the screen sent and what it did with the answer — not about a
 * mock of the screen's own module.
 */

function clientOver(handler: (url: string, init: RequestInit) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init ?? {}))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A `QueryClient` with retries off.
 *
 * The production client retries a 5xx twice, which is right in a browser and wrong in a test:
 * an assertion about an error state would wait for two backoffs before the state it is
 * waiting for exists.
 */
function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('ID-01 development sign-in', () => {
  it('posts the user id to the development route and reports the session', async () => {
    const user = userEvent.setup();
    const calls: { url: string; init: RequestInit }[] = [];
    const onSignedIn = vi.fn();

    const client = clientOver((url, init) => {
      calls.push({ url, init });
      return json({ csrfToken: 'abc', expiresAt: '2026-08-26T12:00:00.000Z' }, 201);
    });

    render(<SignInScreen client={client} onSignedIn={onSignedIn} developmentSignInEnabled />);

    await user.type(screen.getByLabelText(/User id/), '0198f0aa-0000-7000-8000-000000000001');
    await user.click(screen.getByRole('button', { name: /Start a development session/ }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.test/v1/dev/sessions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      userId: '0198f0aa-0000-7000-8000-000000000001',
    });
    expect(screen.getByText('Session started')).toBeInTheDocument();
  });

  it('trims the user id before sending it', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];
    const client = clientOver((_url, init) => {
      bodies.push(String(init.body));
      return json({ csrfToken: 'abc', expiresAt: 'x' }, 201);
    });

    render(<SignInScreen client={client} developmentSignInEnabled />);
    await user.type(screen.getByLabelText(/User id/), '  spaced  ');
    await user.click(screen.getByRole('button', { name: /Start a development session/ }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0]!)).toEqual({ userId: 'spaced' });
  });

  it('refuses an empty user id without sending anything', async () => {
    const user = userEvent.setup();
    const fetched = vi.fn();
    const client = clientOver((url) => {
      fetched(url);
      return json({}, 201);
    });

    render(<SignInScreen client={client} developmentSignInEnabled />);
    await user.click(screen.getByRole('button', { name: /Start a development session/ }));

    expect(fetched).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the user id to sign in as/)).toBeInTheDocument();
  });

  it('shows the API refusal rather than a generic failure', async () => {
    const user = userEvent.setup();
    const client = clientOver(() =>
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'userId is required',
            correlationId: 'c1',
          },
        },
        400,
      ),
    );

    render(<SignInScreen client={client} developmentSignInEnabled />);
    await user.type(screen.getByLabelText(/User id/), 'nope');
    await user.click(screen.getByRole('button', { name: /Start a development session/ }));

    expect(await screen.findByText(/userId is required/)).toBeInTheDocument();
    expect(screen.queryByText('Session started')).toBeNull();
  });

  it('says the API did not answer when the request never arrived', async () => {
    const user = userEvent.setup();
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });

    render(<SignInScreen client={client} developmentSignInEnabled />);
    await user.type(screen.getByLabelText(/User id/), 'someone');
    await user.click(screen.getByRole('button', { name: /Start a development session/ }));

    expect(await screen.findByText(/The API did not answer/)).toBeInTheDocument();
  });
});

describe('ID-05 sessions and devices', () => {
  const SESSIONS = [
    {
      id: 'session-1',
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
      createdAt: '2026-08-20T09:00:00.000Z',
      rotatedAt: '2026-08-26T08:00:00.000Z',
      expiresAt: '2026-09-20T09:00:00.000Z',
    },
    {
      id: 'session-2',
      userAgent: null,
      createdAt: '2026-08-01T09:00:00.000Z',
      rotatedAt: null,
      expiresAt: '2026-09-01T09:00:00.000Z',
    },
  ];

  it('lists the sessions the API returned', async () => {
    const client = clientOver(() => json({ sessions: SESSIONS }));
    render(withQuery(<SessionsScreen client={client} />));

    expect(await screen.findByText('Mozilla/5.0 (Macintosh) Chrome/140')).toBeInTheDocument();
    expect(screen.getByText('Unknown device')).toBeInTheDocument();
  });

  it('offers no per-session revoke, because there is no route for one', async () => {
    const client = clientOver(() => json({ sessions: SESSIONS }));
    render(withQuery(<SessionsScreen client={client} />));

    await screen.findByText('Mozilla/5.0 (Macintosh) Chrome/140');
    for (const button of screen.getAllByRole('button', { name: 'Revoke' })) {
      expect(button).toBeDisabled();
    }
  });

  it('signs out through the real route and reports it', async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string | undefined }[] = [];
    const onSignedOut = vi.fn();

    const client = clientOver((url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ sessions: SESSIONS });
    });

    render(withQuery(<SessionsScreen client={client} onSignedOut={onSignedOut} />));
    await screen.findByText('Mozilla/5.0 (Macintosh) Chrome/140');

    await user.click(screen.getByRole('button', { name: /Sign out of this session/ }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));

    expect(
      calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/v1/sessions/current')),
    ).toBe(true);
  });

  it('reports a refusal instead of an empty list', async () => {
    const client = clientOver(() =>
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'Your session has ended. Sign in again to continue.',
            correlationId: 'c',
          },
        },
        401,
      ),
    );

    render(withQuery(<SessionsScreen client={client} />));
    expect(await screen.findByText('Could not load your sessions')).toBeInTheDocument();
    expect(screen.getByText(/Your session has ended/)).toBeInTheDocument();
  });

  it('says so when there are no sessions at all', async () => {
    const client = clientOver(() => json({ sessions: [] }));
    render(withQuery(<SessionsScreen client={client} />));
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('has no axe violations once loaded', async () => {
    const client = clientOver(() => json({ sessions: SESSIONS }));
    const { container } = render(withQuery(<SessionsScreen client={client} />));
    await screen.findByText('Mozilla/5.0 (Macintosh) Chrome/140');
    await expectNoAxeViolations(container);
  });
});
