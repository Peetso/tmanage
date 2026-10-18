import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignUpScreen } from '../src/components/screens/SignUpScreen';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { ApiClient } from '../src/lib/api/client';
import { AuthBoundary } from '../src/lib/auth-boundary';
import { isPublicSignupOffered } from '../src/lib/public-signup';
import { expectNoAxeViolations } from './axe';

/**
 * **Public sign-up (`/sign-up`).** The limits, the switch's 404 and tenant isolation are the
 * API's and are proved there; this file proves what the screen does with the answers.
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

const open = (post: () => Response) =>
  clientOver((call) => (call.method === 'POST' ? post() : json({ available: true })));

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Your name/), 'Mona Adel');
  await user.type(screen.getByLabelText(/^Work email/), 'mona@example.com');
  await user.type(screen.getByLabelText(/^Password/), 'violet-harbour-lantern-41');
  await user.type(screen.getByLabelText(/^Workspace name/), 'Nile Studio');
}

async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled());
}

describe('SignUpScreen', () => {
  it('creates the account and goes to the new workspace, signed in', async () => {
    const user = userEvent.setup();
    const onCompleted = vi.fn();
    const boundary = new AuthBoundary();
    const announced: string[] = [];
    boundary.subscribe((notice) => announced.push(notice.event));
    const { client, calls } = open(() =>
      json(
        {
          status: 'authenticated',
          csrfToken: 'csrf-1',
          expiresAt: '2026-10-19T00:00:00.000Z',
          organizationSlug: 'nile-studio',
        },
        201,
      ),
    );
    render(<SignUpScreen client={client} boundary={boundary} onCompleted={onCompleted} />);
    await ready();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('nile-studio'));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.example.test/v1/public/sign-up');
    expect(post?.body).toMatchObject({
      displayName: 'Mona Adel',
      email: 'mona@example.com',
      organizationName: 'Nile Studio',
      website: '',
    });
    expect(announced).toContain('signed-in');
  });

  it('says "you already have an account" with a sign-in link on 409', async () => {
    const user = userEvent.setup();
    const { client } = open(() =>
      json(
        {
          error: {
            code: 'conflict',
            message: 'You already have an account. Sign in instead.',
            details: [{ field: 'email', message: 'account_exists' }],
          },
        },
        409,
      ),
    );
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/You already have an account/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Sign in' }).length).toBeGreaterThan(0);
  });

  it('shows "not open" and no form when the switch is off (404)', async () => {
    const { client } = clientOver(() => json({ error: { code: 'not_found', message: 'x' } }, 404));
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign-up is not open' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
  });

  it('has no axe violations once open', async () => {
    const { client } = open(() => json({}, 500));
    const { container } = render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    await expectNoAxeViolations(container);
  });
});

describe('the sign-in page link and the PUBLIC_SIGNUP build flag', () => {
  it('offers "Create an account" when sign-up is on, and hides it when off', () => {
    const { client } = clientOver(() => json({}));
    const { unmount } = render(
      <SignInScreen client={client} signUpOffered developmentSignInEnabled={false} />,
    );
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-up',
    );
    unmount();
    render(<SignInScreen client={client} signUpOffered={false} developmentSignInEnabled={false} />);
    expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull();
  });

  it('defaults to on, and only an explicit off turns it off', () => {
    expect(isPublicSignupOffered(undefined)).toBe(true);
    expect(isPublicSignupOffered('on')).toBe(true);
    expect(isPublicSignupOffered('OFF')).toBe(false);
    expect(isPublicSignupOffered('false')).toBe(false);
  });
});
