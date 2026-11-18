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

/** Step 1 (e-mail) then step 2 (name, workspace, password), as a person fills the funnel. */
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Email/), 'mona@example.com');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/^Full name/), 'Mona Adel');
  const workspace = screen.getByLabelText(/^Workspace name/);
  await user.clear(workspace);
  await user.type(workspace, 'Nile Studio');
  await user.type(screen.getByLabelText(/^Password/), 'violet-harbour-lantern-41');
}

async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
}

describe('SignUpScreen', () => {
  it('Start free creates the workspace, signs in and shows the check-your-email state', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Create my workspace' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check your email' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/mona@example.com/)).toBeInTheDocument();
    expect(onCompleted).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open my workspace' }));
    // PLANWEB: no `?plan=` and no plan in the answer, so no plan is carried.
    expect(onCompleted).toHaveBeenCalledWith('nile-studio', null);
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
    await user.click(screen.getByRole('button', { name: 'Create my workspace' }));

    // Back on step 1, where the e-mail is: the card, and Sign in in place of Continue.
    expect(await screen.findByText('You already have an account')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Start your free workspace' }),
    ).toHaveFocus();
    expect(screen.getByLabelText(/^Email/)).toHaveValue('mona@example.com');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/sign-in');
  });

  it('shows "not open" and no form when the switch is off (404)', async () => {
    const { client } = clientOver(() => json({ error: { code: 'not_found', message: 'x' } }, 404));
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign-up is not open' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create my workspace' })).toBeNull();
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

describe('Continue with Google', () => {
  it('is hidden when the API has no Google client (404) and shown when it has one', async () => {
    const off = clientOver((call) =>
      call.url.endsWith('/v1/auth/google')
        ? json({ error: { code: 'not_found', message: 'x' } }, 404)
        : json({}),
    );
    const { unmount } = render(
      <SignInScreen client={off.client} signUpOffered developmentSignInEnabled={false} />,
    );
    await waitFor(() =>
      expect(off.calls.some((c) => c.url.endsWith('/v1/auth/google'))).toBe(true),
    );
    expect(screen.queryByRole('button', { name: /Continue with Google/ })).toBeNull();
    unmount();

    const on = clientOver((call) =>
      call.url.endsWith('/v1/auth/google') ? json({ available: true, signUp: true }) : json({}),
    );
    render(<SignInScreen client={on.client} signUpOffered developmentSignInEnabled={false} />);
    expect(await screen.findByRole('button', { name: /Continue with Google/ })).toBeInTheDocument();
  });

  it('starts a sign-up attempt from step 1', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign, search: '' },
    });
    try {
      const { client, calls } = clientOver((call) => {
        if (call.url.endsWith('/v1/auth/google')) return json({ available: true, signUp: true });
        if (call.url.endsWith('/v1/auth/google/start'))
          return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
        return json({ available: true });
      });
      render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
      await ready();
      await user.click(await screen.findByRole('button', { name: /Continue with Google/ }));
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'),
      );
      expect(calls.find((c) => c.url.endsWith('/v1/auth/google/start'))?.body).toEqual({
        intent: 'sign-up',
      });
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('the two-step funnel (SIGNUP2)', () => {
  it('step 1 checks the e-mail on the client and sends nothing', async () => {
    const user = userEvent.setup();
    const { client, calls } = open(() => json({}, 500));
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Check the e-mail address')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Email/), 'omar@northstar');
    await user.keyboard('{Enter}');
    expect(screen.getByText('Check the e-mail address')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByLabelText(/^Full name/)).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows the terms line with its links in place of a checkbox', async () => {
    const { client } = open(() => json({}, 500));
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/legal/privacy',
    );
    expect(screen.getByLabelText(/^Email/)).toHaveAttribute('placeholder', 'you@example.com');
  });

  it('step 2 suggests the workspace, keeps values over Back and submits once with every field', async () => {
    const user = userEvent.setup();
    const { client, calls } = open(() =>
      json(
        {
          status: 'authenticated',
          csrfToken: 'csrf-1',
          expiresAt: '2026-10-19T00:00:00.000Z',
          organizationSlug: 'northstar-studio',
        },
        201,
      ),
    );
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} onCompleted={vi.fn()} />);
    await ready();
    await user.type(screen.getByLabelText(/^Email/), 'omar@northstar.studio{Enter}');

    const title = await screen.findByRole('heading', { level: 1, name: 'Almost there' });
    expect(title).toHaveFocus();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('omar@northstar.studio')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Workspace name/)).toHaveValue('Northstar Studio');

    await user.type(screen.getByLabelText(/^Full name/), 'Omar Adel');
    const password = screen.getByLabelText(/^Password/);
    await user.type(password, 'violet-harbour-lantern-41');
    expect(password).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Start your free workspace' }),
    ).toHaveFocus();
    expect(screen.getByLabelText(/^Email/)).toHaveValue('omar@northstar.studio');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText(/^Full name/)).toHaveValue('Omar Adel');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    // Enter in a field submits step 2; the typed password survived Back.
    await user.type(screen.getByLabelText(/^Password/), '{Enter}');
    await screen.findByRole('heading', { level: 1, name: 'Check your email' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      displayName: 'Omar Adel',
      email: 'omar@northstar.studio',
      organizationName: 'Northstar Studio',
      password: 'violet-harbour-lantern-41',
      website: '',
    });
    expect(Object.keys(posts[0]?.body as object)).not.toContain('agree');
  });

  it('refuses a short password on step 2 without calling the API', async () => {
    const user = userEvent.setup();
    const { client, calls } = open(() => json({}, 500));
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    await user.type(screen.getByLabelText(/^Email/), 'mona@gmail.com{Enter}');
    await user.type(await screen.findByLabelText(/^Full name/), 'Mona Adel');
    // A free mail provider: the suggestion follows the person's name.
    expect(screen.getByLabelText(/^Workspace name/)).toHaveValue('Mona Adel');
    await user.type(screen.getByLabelText(/^Password/), 'short');
    await user.click(screen.getByRole('button', { name: 'Create my workspace' }));
    expect(await screen.findByText('Some fields need attention.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('in an in-app browser puts the e-mail first, then "or", then the notice', async () => {
    const agent = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0.32.97',
      );
    try {
      const { client } = clientOver((call) =>
        call.url.endsWith('/v1/auth/google')
          ? json({ available: true, signUp: true })
          : json({ available: true }),
      );
      render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
      const notice = await screen.findByTestId('in-app-browser-notice');
      expect(screen.queryByRole('button', { name: /Continue with Google/ })).toBeNull();
      const email = screen.getByLabelText(/^Email/);
      const or = screen.getByText('or');
      const follows = (a: Node, b: Node) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(follows(email, or)).toBe(true);
      expect(follows(or, notice)).toBe(true);
    } finally {
      agent.mockRestore();
    }
  });
});

describe('when /sign-up cannot load (SIGNUP3)', () => {
  const availabilityCalls = (calls: Call[]) =>
    calls.filter((c) => c.method === 'GET' && c.url.endsWith('/v1/public/sign-up')).length;

  it('retries twice, then offers Try again instead of a sign-up error, and recovers', async () => {
    const user = userEvent.setup();
    let reachable = false;
    const { client, calls } = clientOver((call) => {
      if (!call.url.endsWith('/v1/public/sign-up')) return json({});
      return reachable
        ? json({ available: true })
        : json({ error: { code: 'unavailable', message: 'x' } }, 503);
    });
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} retryDelaysMs={[0, 0]} />);

    const tryAgain = await screen.findByRole('button', { name: 'Try again' });
    expect(availabilityCalls(calls)).toBe(3);
    expect(
      screen.getByText("Sign-up didn't load. Check your connection and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Could not create your account')).toBeNull();
    expect(tryAgain.parentElement).toHaveFocus();
    expect(screen.getByRole('heading', { level: 1, name: 'Start your free workspace' }));
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');

    reachable = true;
    await user.click(tryAgain);
    await ready();
    expect(screen.getByLabelText(/^Email/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the form when only the optional Google probe fails', async () => {
    const { client } = clientOver((call) =>
      call.url.endsWith('/v1/auth/google')
        ? json({ error: { code: 'internal', message: 'x' } }, 500)
        : json({ available: true }),
    );
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    expect(screen.getByLabelText(/^Email/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with Google/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('keeps "Could not create your account" for a failed submit, with the values kept', async () => {
    const user = userEvent.setup();
    const { client } = open(() => json({ error: { code: 'internal', message: 'x' } }, 500));
    render(<SignUpScreen client={client} boundary={new AuthBoundary()} />);
    await ready();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create my workspace' }));
    expect(await screen.findByText('Could not create your account')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Full name/)).toHaveValue('Mona Adel');
    expect(screen.getByRole('button', { name: 'Create my workspace' })).toBeEnabled();
  });
});
