import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RecoveryScreen } from '../src/components/screens/RecoveryScreen';
import { ApiClient } from '../src/lib/api/client';

/** ACC-02: a locked-out person resets their own password from the email link. */

interface Call {
  readonly url: string;
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
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN = 'R'.repeat(43);

describe('ID-05 password reset', () => {
  it('asks for a link and then says, without confirming the account, that one may be on its way', async () => {
    const { client, calls } = clientOver(() => json({ status: 'requested' }, 202));
    render(<RecoveryScreen client={client} />);

    await userEvent.type(screen.getByLabelText(/Work email/), 'sara@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send a recovery link' }));

    expect(await screen.findByText(/If an account exists for that address/)).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/v1/password-resets');
    expect(calls[0]?.body).toEqual({ email: 'sara@example.com' });
  });

  it('sets a new password from the link and reports it, never rendering the token', async () => {
    const { client, calls } = clientOver(() => new Response(null, { status: 204 }));
    const { container } = render(<RecoveryScreen token={TOKEN} client={client} />);

    await userEvent.type(screen.getByLabelText(/New password/), 'violet-harbour-lantern-41');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));

    expect(await screen.findByText('Your password was changed')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/v1/password-resets/completions');
    expect(calls[0]?.body).toEqual({ token: TOKEN, password: 'violet-harbour-lantern-41' });
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('shows the expired state for a used or expired link, and offers a new one', async () => {
    const { client } = clientOver(() =>
      json({ error: { code: 'not_found', message: 'nf', correlationId: 'c' } }, 404),
    );
    render(<RecoveryScreen token={TOKEN} client={client} />);

    await userEvent.type(screen.getByLabelText(/New password/), 'violet-harbour-lantern-41');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));

    expect(await screen.findByText('That link has expired')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Request a new link' }));
    expect(screen.getByRole('heading', { name: 'Recover access' })).toBeInTheDocument();
  });

  it('shows the password problem beside the field', async () => {
    const { client } = clientOver(() =>
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'Choose a different password.',
            correlationId: 'c',
            details: [{ field: 'password', message: 'Use at least 8 characters.' }],
          },
        },
        422,
      ),
    );
    render(<RecoveryScreen token={TOKEN} client={client} />);

    await userEvent.type(screen.getByLabelText(/New password/), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
  });
});
