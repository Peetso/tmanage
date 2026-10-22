import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

/** t1-b: the new password, its confirmation, then "Save password and sign in". */
async function submitNewPassword(password: string): Promise<void> {
  await userEvent.type(screen.getByLabelText(/^New password/), password);
  await userEvent.type(screen.getByLabelText(/^Confirm new password/), password);
  await userEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
}

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

  it('sets a new password from the link and goes to sign-in, never rendering the token', async () => {
    const { client, calls } = clientOver(() => new Response(null, { status: 204 }));
    const navigate = vi.fn();
    const { container } = render(
      <RecoveryScreen token={TOKEN} client={client} navigate={navigate} />,
    );

    await submitNewPassword('violet-harbour-lantern-41');

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/sign-in'));
    expect(calls[0]?.url).toContain('/v1/password-resets/completions');
    expect(calls[0]?.body).toEqual({ token: TOKEN, password: 'violet-harbour-lantern-41' });
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('shows the expired state for a used or expired link, and offers a new one', async () => {
    const { client } = clientOver(() =>
      json({ error: { code: 'not_found', message: 'nf', correlationId: 'c' } }, 404),
    );
    render(<RecoveryScreen token={TOKEN} client={client} />);

    await submitNewPassword('violet-harbour-lantern-41');

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

    await submitNewPassword('harbour-violet-99');

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
  });
});
