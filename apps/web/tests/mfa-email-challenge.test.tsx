import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MfaChallengeScreen } from '../src/components/screens/MfaChallengeScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * MFAOPTIONS. The sign-in step when e-mail is the default method: a code is sent once, the
 * address is shown masked, the six boxes are one input, the code goes to `/v1/auth/mfa` with
 * `method: 'email'`, and "Try another way" offers only the other methods the server listed.
 */

interface Call {
  readonly url: string;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

const SENT = { sentTo: 'p•••@example.test', resendAfterSeconds: 30, expiresInSeconds: 600 };
const AUTHENTICATED = {
  status: 'authenticated',
  csrfToken: 'v1.abc',
  expiresAt: '2026-09-09T00:00:00.000Z',
};

describe('the e-mail code challenge', () => {
  it('sends one code, shows the masked address, and finishes with method email', async () => {
    const { client, calls } = clientOver((call) =>
      call.url.endsWith('/v1/auth/mfa/email-code') ? json(SENT) : json(AUTHENTICATED),
    );
    render(
      <MfaChallengeScreen
        client={client}
        challengeToken="challenge-1"
        factors={[
          { kind: 'email', label: 'E-mail' },
          { kind: 'totp', label: 'Phone' },
        ]}
      />,
    );

    expect(await screen.findByText(/p•••@example\.test/u)).toBeInTheDocument();
    const sends = calls.filter((call) => call.url.endsWith('/v1/auth/mfa/email-code'));
    expect(sends).toEqual([
      {
        url: 'https://api.example.test/v1/auth/mfa/email-code',
        body: { challengeToken: 'challenge-1' },
      },
    ]);

    // One input for screen readers, with platform autofill.
    const input = screen.getByLabelText('Six-digit code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);

    // The other enabled method is offered; e-mail itself is not.
    expect(screen.getByRole('button', { name: 'Use your authenticator app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get a code by e-mail' })).toBeNull();

    await userEvent.type(input, '042137');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        url: 'https://api.example.test/v1/auth/mfa',
        body: { challengeToken: 'challenge-1', code: '042137', method: 'email' },
      }),
    );
  });

  it('sends no code and no method field when the authenticator is the default', async () => {
    const { client, calls } = clientOver(() => json(AUTHENTICATED));
    render(
      <MfaChallengeScreen
        client={client}
        challengeToken="challenge-2"
        factors={[
          { kind: 'totp', label: 'Phone' },
          { kind: 'email', label: 'E-mail' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Get a code by e-mail' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Six-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          url: 'https://api.example.test/v1/auth/mfa',
          body: { challengeToken: 'challenge-2', code: '123456' },
        },
      ]),
    );
  });
});
