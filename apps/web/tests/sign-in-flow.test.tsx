import { render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * ID-01 into ID-02, driven against an `ApiClient` this file supplies.
 *
 * The API's own behaviour is proved in `apps/api/test/id-002-auth-http.db.test.ts` against a
 * real server. What only this file can prove is what the *screen* does with the two answers
 * that endpoint can give — and, in particular, that the challenge token never leaves React
 * state.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      // The "Continue with Google" / "Continue with Microsoft" availability probes are not part
      // of these flows: answer them "not configured" (404) and keep them out of the recorded calls.
      if (call.url.endsWith('/v1/auth/google') || call.url.endsWith('/v1/auth/microsoft')) {
        return Promise.resolve(json({ error: { code: 'not_found', message: 'Not found' } }, 404));
      }
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const AUTHENTICATED = {
  status: 'authenticated',
  csrfToken: 'v1.abc',
  expiresAt: '2026-09-09T00:00:00.000Z',
};

const CHALLENGED = {
  status: 'mfa_required',
  challengeToken: 'c1.mfa.user-1.99999999999.signature',
  expiresAt: '2026-08-26T12:05:00.000Z',
  factors: [{ id: 'factor-1', kind: 'totp', label: 'Omar’s iPhone' }],
};

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Work email/), 'omar@northstar.studio');
  await user.type(screen.getByLabelText(/^Password/), 'a quiet line on paper');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('signing in with a password', () => {
  // No query gates this cold page, so the fields ship inside a hydration-disabled fieldset: a
  // keystroke landed before React hydrates cannot be silently wiped. Enabled once hydrated.
  it('ships the fields disabled on the server render and enables them once hydrated', () => {
    const { client } = clientOver(() => json(AUTHENTICATED));

    const ssr = renderToString(<SignInScreen client={client} developmentSignInEnabled={false} />);
    expect(ssr).toMatch(/<fieldset[^>]*\bdisabled\b/);

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    expect(screen.getByLabelText(/Work email/)).toBeEnabled();
    expect(screen.getByLabelText(/^Password/)).toBeEnabled();
  });

  it('posts the credentials to the real endpoint', async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    const { client, calls } = clientOver(() => json(AUTHENTICATED));

    render(
      <SignInScreen client={client} onSignedIn={onSignedIn} developmentSignInEnabled={false} />,
    );
    await signIn(user);

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.test/v1/auth/password');
    expect(calls[0]?.method).toBe('POST');
    // R12: plus the advisory `client` signals (keys typed, ms on the form, webdriver flag).
    expect(calls[0]?.body).toMatchObject({
      email: 'omar@northstar.studio',
      password: 'a quiet line on paper',
      client: { webdriver: false, keystrokes: expect.any(Number), formMs: expect.any(Number) },
    });
  });

  it('trims the address but never the password', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json(AUTHENTICATED));

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await user.type(screen.getByLabelText(/Work email/), '  omar@northstar.studio  ');
    await user.type(screen.getByLabelText(/^Password/), ' spaced password ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      email: 'omar@northstar.studio',
      password: ' spaced password ',
    });
  });

  it('renders the API refusal verbatim rather than inventing a more helpful one', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'The request carries no valid session',
            correlationId: 'c1',
          },
        },
        401,
      ),
    );

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);

    expect(await screen.findByText('The request carries no valid session')).toBeInTheDocument();
    // Nothing on the screen distinguishes an unknown address from a wrong password.
    expect(screen.queryByText(/no account/i)).toBeNull();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it('reports a lockout as its own thing, because waiting is the fix', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'rate_limited',
            message: 'Too many attempts. Wait a few minutes and try again.',
            correlationId: 'c1',
          },
        },
        429,
      ),
    );

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);

    expect(await screen.findByText(/Wait a few minutes/)).toBeInTheDocument();
  });

  it('refuses an empty form without sending anything', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json(AUTHENTICATED));

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(calls).toHaveLength(0);
    expect(screen.getByText(/Enter your work email and password/)).toBeInTheDocument();
  });
});

describe('the second factor', () => {
  it('renders the challenge in place rather than navigating', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() => json(CHALLENGED));

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);

    expect(await screen.findByText('Confirm it’s you')).toBeInTheDocument();
    // TXT-01: the identity eyebrow shows its human label only — the "ID-02" screen code is gone.
    expect(screen.getByText('Sign in', { selector: '.tm-identity__eyebrow' })).toBeInTheDocument();
    expect(screen.queryByText(/ID-02/)).toBeNull();
    // The factor's label from the challenge, as device context.
    expect(screen.getByText('Omar’s iPhone')).toBeInTheDocument();
  });

  /**
   * The property the whole in-place arrangement exists for. A challenge token in a URL would
   * be in the address bar, in history, and in the next `Referer`.
   */
  it('never puts the challenge token in the document', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() => json(CHALLENGED));

    const { container } = render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);
    await screen.findByText('Confirm it’s you');

    expect(container.innerHTML).not.toContain(CHALLENGED.challengeToken);
    expect(window.location.href).not.toContain(CHALLENGED.challengeToken);
  });

  it('sends the code and the token to the mfa endpoint', async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    const { client, calls } = clientOver((call) =>
      call.url.endsWith('/v1/auth/password') ? json(CHALLENGED) : json(AUTHENTICATED),
    );

    render(
      <SignInScreen client={client} onSignedIn={onSignedIn} developmentSignInEnabled={false} />,
    );
    await signIn(user);
    await screen.findByText('Confirm it’s you');

    await user.type(screen.getByLabelText(/Six-digit code/), '417295');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(calls[1]?.url).toBe('https://api.example.test/v1/auth/mfa');
    expect(calls[1]?.body).toEqual({
      challengeToken: CHALLENGED.challengeToken,
      code: '417295',
    });
  });

  it('strips the spaces an authenticator app puts in the middle', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) =>
      call.url.endsWith('/v1/auth/password') ? json(CHALLENGED) : json(AUTHENTICATED),
    );

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);
    await screen.findByText('Confirm it’s you');

    await user.type(screen.getByLabelText(/Six-digit code/), '417 295');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1]?.body as { code: string }).code).toBe('417295');
  });

  it('sends a recovery code to its own endpoint, unaltered', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver((call) =>
      call.url.endsWith('/v1/auth/password') ? json(CHALLENGED) : json(AUTHENTICATED),
    );

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);
    await screen.findByText('Confirm it’s you');

    await user.click(screen.getByRole('button', { name: /Use a backup code/ }));
    await user.type(screen.getByLabelText(/Recovery code/), 'K7M2P-9XQ4R');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.url).toBe('https://api.example.test/v1/auth/recovery-code');
    expect(calls[1]?.body).toEqual({
      challengeToken: CHALLENGED.challengeToken,
      code: 'K7M2P-9XQ4R',
    });
  });

  it('clears the field after a refusal, so a stale code is not resubmitted', async () => {
    const user = userEvent.setup();
    const { client } = clientOver((call) =>
      call.url.endsWith('/v1/auth/password')
        ? json(CHALLENGED)
        : json(
            {
              error: {
                code: 'unauthenticated',
                message: 'The request carries no valid session',
                correlationId: 'c1',
              },
            },
            401,
          ),
    );

    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await signIn(user);
    await screen.findByText('Confirm it’s you');

    await user.type(screen.getByLabelText(/Six-digit code/), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('That did not work')).toBeInTheDocument();
    expect(screen.getByLabelText(/Six-digit code/)).toHaveValue('');
  });
});

describe('the development panel', () => {
  it('is a separate path and still works, for an account with no password', async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    const { client, calls } = clientOver(() => json({ csrfToken: 'v1.abc', expiresAt: 'x' }, 201));

    render(<SignInScreen client={client} onSignedIn={onSignedIn} developmentSignInEnabled />);
    await user.type(screen.getByLabelText(/User id/), 'user-1');
    await user.click(screen.getByRole('button', { name: /Start a development session/ }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(calls[0]?.url).toBe('https://api.example.test/v1/dev/sessions');
    expect(screen.getByText('Session started')).toBeInTheDocument();
  });
});
