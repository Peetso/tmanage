import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryScreen } from '../src/components/screens/RecoveryScreen';
import { ApiClient } from '../src/lib/api/client';

/** P2 / t1-b: choose a new password from the emailed link. Keys render as-is, merge-proof. */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));

const TOKEN = 'R'.repeat(43);

function clientAnswering(response: () => Response) {
  const bodies: unknown[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      return Promise.resolve(response());
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  return { client, bodies };
}

async function fill(password: string, confirmation: string) {
  await userEvent.type(screen.getByLabelText(/^RecoveryScreen.newPassword/), password);
  await userEvent.type(screen.getByLabelText(/^Recovery.confirmPassword/), confirmation);
  await userEvent.click(screen.getByRole('button', { name: 'Recovery.saveAndSignIn' }));
}

describe('P2 choose a new password', () => {
  it('refuses a mismatched confirmation without calling the API', async () => {
    const { client, bodies } = clientAnswering(() => new Response(null, { status: 204 }));
    render(<RecoveryScreen token={TOKEN} client={client} navigate={vi.fn()} />);
    await fill('violet-harbour-41', 'violet-harbour-42');
    expect(screen.getByText('Recovery.mismatch')).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it('saves the password and goes to sign-in', async () => {
    const navigate = vi.fn();
    const { client, bodies } = clientAnswering(() => new Response(null, { status: 204 }));
    render(<RecoveryScreen token={TOKEN} client={client} navigate={navigate} />);
    await fill('violet-harbour-41', 'violet-harbour-41');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/sign-in'));
    expect(bodies[0]).toEqual({ token: TOKEN, password: 'violet-harbour-41' });
  });

  it('shows the used-or-expired state when the API answers 404', async () => {
    const { client } = clientAnswering(
      () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    render(<RecoveryScreen token={TOKEN} client={client} navigate={vi.fn()} />);
    await fill('violet-harbour-41', 'violet-harbour-41');
    expect(await screen.findByText('RecoveryScreen.linkExpired')).toBeInTheDocument();
  });
});
