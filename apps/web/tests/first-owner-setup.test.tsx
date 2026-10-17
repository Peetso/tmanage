import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FirstOwnerSetupScreen } from '../src/components/screens/FirstOwnerSetupScreen';
import { ApiClient } from '../src/lib/api/client';
import { AuthBoundary } from '../src/lib/auth-boundary';
import { expectNoAxeViolations } from './axe';

/**
 * **First-owner setup (`/setup`).**
 *
 * The guard — token, empty database, the locked transaction, the rate limit — is the API's and is
 * proved there. What only this file can prove is what the *screen* does with the API's answers: a
 * 404 from the availability check shows "not available" and no form, a submission posts the typed
 * fields to `POST /public/setup` with the token in the body and never in the URL and then goes to
 * the new organization, a 401 shows the wrong-token wording, and the form has no axe violation
 * jsdom can detect.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const TOKEN = 'setup-token-for-tests-only';

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

/** Setup is open; the POST answers with `post`. */
function openSetup(post: () => Response) {
  return clientOver((call) => (call.method === 'POST' ? post() : json({ available: true }, 200)));
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Setup token/), TOKEN);
  await user.type(screen.getByLabelText(/Your name/), 'Ada Lovelace');
  await user.type(screen.getByLabelText(/^Email/), 'ada@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'correct-horse-battery');
  await user.type(screen.getByLabelText(/Organization name/), 'Analytical Engines');
}

async function formReady() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create owner account' })).toBeEnabled(),
  );
}

describe('FirstOwnerSetupScreen', () => {
  it('shows "not available" and no form when the availability check answers 404', async () => {
    const { client } = clientOver(() =>
      json({ error: { code: 'not_found', message: 'Not found' } }, 404),
    );
    render(<FirstOwnerSetupScreen client={client} boundary={new AuthBoundary()} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Setup is not available' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Setup token/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create owner account' })).not.toBeInTheDocument();
  });

  it('posts the typed fields with the token in the body only, then goes to the new organization', async () => {
    const user = userEvent.setup();
    const onCompleted = vi.fn();
    const { client, calls } = openSetup(() =>
      json(
        {
          status: 'authenticated',
          csrfToken: 'csrf-1',
          expiresAt: '2026-10-18T00:00:00.000Z',
          organizationSlug: 'analytical-engines',
        },
        201,
      ),
    );
    render(
      <FirstOwnerSetupScreen
        client={client}
        boundary={new AuthBoundary()}
        onCompleted={onCompleted}
      />,
    );

    await formReady();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create owner account' }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('analytical-engines'));
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain('/public/setup');
    expect(posts[0]!.body).toEqual({
      setupToken: TOKEN,
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      password: 'correct-horse-battery',
      organizationName: 'Analytical Engines',
      slug: 'analytical-engines',
      timezone: expect.any(String),
      defaultLocale: 'en',
    });
    // The secret never reaches a URL.
    for (const call of calls) expect(call.url).not.toContain(TOKEN);
  });

  it('says the token is wrong when the API answers 401', async () => {
    const user = userEvent.setup();
    const onCompleted = vi.fn();
    const { client } = openSetup(() =>
      json({ error: { code: 'unauthenticated', message: 'Unauthorized' } }, 401),
    );
    render(
      <FirstOwnerSetupScreen
        client={client}
        boundary={new AuthBoundary()}
        onCompleted={onCompleted}
      />,
    );

    await formReady();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create owner account' }));

    expect(await screen.findByText('That setup token is not correct.')).toBeInTheDocument();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('renders the setup form accessibly', async () => {
    const { client } = openSetup(() => json({}, 500));
    const { container } = render(
      <FirstOwnerSetupScreen client={client} boundary={new AuthBoundary()} />,
    );

    await formReady();
    await expectNoAxeViolations(container);
  });
});
