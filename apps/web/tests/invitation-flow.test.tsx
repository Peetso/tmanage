import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { InvitationScreen } from '../src/components/screens/InvitationScreen';
import { InviteTeamScreen } from '../src/components/screens/InviteTeamScreen';
import { ApiClient } from '../src/lib/api/client';
import { authBoundary } from '../src/lib/auth-boundary';
import { expectNoAxeViolations } from './axe';

/**
 * `ON-04` and `ID-03` against the endpoints TEN-003 delivered.
 *
 * What the API does — the hashed token, the single-use `WHERE` clause, the acceptance path that
 * runs with no tenant context — is proved in `apps/api/test/ten-003-invitations.db.test.ts`
 * against a real MySQL. Nothing here re-proves any of it.
 *
 * What only this file can prove is what the screens do:
 *
 * - The invitation token is **never rendered into the document**, only sent in a body.
 * - `ON-04` offers roles this system actually has, and posts one request per address so that
 *   one duplicate does not stop the rest.
 * - The link comes back once and is shown once, with the fact that nothing emailed it.
 * - Every failed token — missing, revoked, expired, used — reads the same on `ID-03`, because
 *   the API answers all four identically and the screen does not try to guess which.
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
    readCsrfToken: () => 'csrf-token',
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

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const TOKEN = 'Qk9WSU5FLVRPS0VOLUZPUi1BLVRFU1QtT05MWS14eHh4';

const PREVIEW = {
  organizationName: 'Northstar Studio',
  inviterName: 'Omar Adel',
  inviterEmail: 'omar@northstar.studio',
  role: 'member',
  audience: 'internal' as const,
  clientOrganizationName: null,
  invitedAt: '2026-08-26T09:00:00.000Z',
  expiresAt: '2026-09-09T09:00:00.000Z',
  inviteeEmail: 'sara@northstar.studio',
  hasAccount: true,
};

const REGISTERED = {
  status: 'authenticated',
  csrfToken: 'csrf-new',
  expiresAt: '2026-10-19T00:00:00.000Z',
  organizationId: 'org-1',
  membershipId: 'm-1',
  clientOrganizationId: null,
  role: 'member',
};

const conflict = (field: string, message: string) =>
  json(
    {
      error: {
        code: 'conflict',
        message: 'conflict',
        correlationId: 'c',
        details: [{ field, message }],
      },
    },
    409,
  );

async function fillRegistration(name = 'Salma Riad', confirm = 'violet-harbour-lantern-41') {
  await screen.findByRole('button', { name: 'Create account and join' });
  await userEvent.type(screen.getByLabelText(/^Full name/), name);
  await userEvent.type(screen.getByLabelText(/^Password/), 'violet-harbour-lantern-41');
  await userEvent.type(screen.getByLabelText(/^Confirm password/), confirm);
  await userEvent.click(screen.getByLabelText(/I agree to the Terms/));
  await userEvent.click(screen.getByRole('button', { name: 'Create account and join' }));
}

describe('Invitation (t1-a), getting in from an invite', () => {
  it('previews by token in a body, never renders it, and names inviter, organization and role', async () => {
    const { client, calls } = clientOver(() => json(PREVIEW));
    const { container } = render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    expect(
      await screen.findByText('Omar Adel invited you to Northstar Studio'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Join Northstar Studio');
    expect(screen.getByText(/joining as a Team member/)).toBeInTheDocument();
    expect(screen.getByText(/This invitation expires on 9 September/)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(TOKEN);
    const previewCall = calls.find((call) => call.url.includes('/invitations/previews'));
    expect(previewCall?.method).toBe('POST');
    expect(previewCall?.body).toEqual({ token: TOKEN });
  });

  it('states that a client invitation is portal access, not team membership', async () => {
    const { client } = clientOver(() =>
      json({ ...PREVIEW, role: 'client_viewer', audience: 'client' }),
    );
    render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    expect(await screen.findByText('This is client portal access')).toBeInTheDocument();
  });

  it('reads the same "not usable" message for an expired, used or withdrawn link', async () => {
    const { client } = clientOver(() => json({ code: 'not_found', message: 'not found' }, 404));
    render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    expect(await screen.findByText('This link is not usable')).toBeInTheDocument();
    expect(screen.getByText(/used already, withdrawn, or expired/)).toBeInTheDocument();
  });

  it('accepts with an existing account and reports the organization it joined', async () => {
    let joined: string | undefined;
    const { client, calls } = clientOver((call) =>
      call.url.includes('/acceptances')
        ? json({ organizationId: 'org-1', membershipId: 'm-1', clientOrganizationId: null }, 201)
        : json(PREVIEW),
    );
    render(
      withQuery(
        <InvitationScreen token={TOKEN} client={client} onAccepted={(id) => (joined = id)} />,
      ),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(joined).toBe('org-1'));
    expect(calls.find((call) => call.url.includes('/acceptances'))?.body).toEqual({
      token: TOKEN,
    });
  });

  it('says "already a member" on 409 already_member (the role-change case)', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/acceptances') ? conflict('token', 'already_member') : json(PREVIEW),
    );
    render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText(/already a member here/)).toBeInTheDocument();
  });

  it('registers somebody with no account, signs them in and reports the organization', async () => {
    let joined: string | undefined;
    const announced: string[] = [];
    const stop = authBoundary.subscribe((notice) => announced.push(notice.event));
    const { client, calls } = clientOver((call) =>
      call.url.includes('/registrations')
        ? json(REGISTERED, 201)
        : json({ ...PREVIEW, hasAccount: false }),
    );
    const { container } = render(
      withQuery(
        <InvitationScreen token={TOKEN} client={client} onAccepted={(id) => (joined = id)} />,
      ),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Create your account' }),
    ).toBeInTheDocument();
    const invitedEmail = screen.getByLabelText(/^Work email/);
    expect(invitedEmail).toHaveValue('sara@northstar.studio');
    expect(invitedEmail).toHaveAttribute('readonly');
    await fillRegistration();

    await waitFor(() => expect(joined).toBe('org-1'));
    stop();
    expect(announced).toContain('signed-in');
    expect(calls.find((call) => call.url.includes('/registrations'))?.body).toEqual({
      token: TOKEN,
      displayName: 'Salma Riad',
      password: 'violet-harbour-lantern-41',
    });
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it('does not send a registration whose two passwords differ', async () => {
    const { client, calls } = clientOver(() => json({ ...PREVIEW, hasAccount: false }));
    render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    await fillRegistration('Salma Riad', 'something-else-entirely');
    expect(await screen.findByText('The two passwords do not match.')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/registrations'))).toBe(false);
  });

  it('tells a registering invitee to sign in when the address already has an account', async () => {
    const { client } = clientOver((call) =>
      call.url.includes('/registrations')
        ? conflict('email', 'account_exists')
        : json({ ...PREVIEW, hasAccount: false }),
    );
    render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    await fillRegistration();
    expect(await screen.findByText(/already uses this email address/)).toBeInTheDocument();
  });

  it('has no axe violations on the registration form', async () => {
    const { client } = clientOver(() => json({ ...PREVIEW, hasAccount: false }));
    const { container } = render(withQuery(<InvitationScreen token={TOKEN} client={client} />));

    await screen.findByRole('button', { name: 'Create account and join' });
    await expectNoAxeViolations(container);
  });
});

describe('ON-04, creating invitations', () => {
  function renderScreen(handler: (call: Call) => Response) {
    const { client, calls } = clientOver(handler);
    render(
      <InviteTeamScreen
        signedInAs="omar@northstar.studio"
        organizationSlug="northstar"
        organizationDomain="northstar.studio"
        existingMembers={['omar@northstar.studio']}
        client={client}
      />,
    );
    return calls;
  }

  function issued(email: string, token: string, delivery: 'sent' | 'none' | 'failed' = 'none') {
    return json(
      {
        invitation: {
          id: `inv-${email}`,
          email,
          role: 'member',
          clientOrganizationId: null,
          status: 'pending',
          expiresAt: '2026-09-09T09:00:00.000Z',
          invitedByUserId: 'user-1',
          acceptedByUserId: null,
          acceptedAt: null,
          createdAt: '2026-08-26T09:00:00.000Z',
        },
        token,
        delivery,
      },
      201,
    );
  }

  async function add(email: string) {
    await userEvent.type(screen.getByLabelText('Email address'), email);
    await userEvent.click(screen.getByRole('button', { name: 'Add to the list' }));
  }

  it('offers only roles this system has', () => {
    renderScreen(() => issued('a@b.test', 't'));

    expect(screen.getByRole('option', { name: 'Team member' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Organization admin' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Freelancer or partner' })).toBeInTheDocument();
    // `guest` is not a client: it must not read as one, and must not read as "Guest".
    expect(screen.queryByRole('option', { name: 'Guest' })).toBeNull();
    // The two the screen used to offer, and which no role in `packages/domain` matches.
    expect(screen.queryByRole('option', { name: 'Admin' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Viewer' })).toBeNull();
  });

  it('posts one request per address, with the role the list carries', async () => {
    const calls = renderScreen((call) =>
      issued(String((call.body as { email: string }).email), 'tok'),
    );

    await add('maya@northstar.studio');
    await add('sara@northstar.studio');
    await userEvent.click(screen.getByRole('button', { name: 'Create 2 invitations' }));

    await waitFor(() => {
      const posts = calls.filter((call) => call.method === 'POST');
      expect(posts).toHaveLength(2);
      expect(posts[0]?.body).toEqual({ email: 'maya@northstar.studio', role: 'member' });
      expect(posts[1]?.body).toEqual({ email: 'sara@northstar.studio', role: 'member' });
    });
  });

  it('shows the link once, and says nothing emailed it when delivery is none', async () => {
    renderScreen(() => issued('maya@northstar.studio', 'THE-TOKEN-VALUE', 'none'));

    await add('maya@northstar.studio');
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 invitation' }));

    expect(await screen.findByText(/THE-TOKEN-VALUE/)).toBeInTheDocument();
    expect(screen.getByText(/you have to send it yourself/i)).toBeInTheDocument();
    expect(screen.getByText(/no way to see it again/i)).toBeInTheDocument();
  });

  it('says the email went out when the server says it did — and still shows the link', async () => {
    renderScreen(() => issued('maya@northstar.studio', 'THE-TOKEN-VALUE', 'sent'));

    await add('maya@northstar.studio');
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 invitation' }));

    expect(await screen.findByText(/THE-TOKEN-VALUE/)).toBeInTheDocument();
    expect(screen.getByText('Also emailed to maya@northstar.studio.')).toBeInTheDocument();
    expect(screen.queryByText(/you have to send it yourself/i)).toBeNull();
  });

  it('keeps the link the whole answer when the server tried to email and failed', async () => {
    renderScreen(() => issued('maya@northstar.studio', 'THE-TOKEN-VALUE', 'failed'));

    await add('maya@northstar.studio');
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 invitation' }));

    expect(await screen.findByText(/THE-TOKEN-VALUE/)).toBeInTheDocument();
    expect(screen.getByText(/The email could not be sent/)).toBeInTheDocument();
  });

  it('keeps a failure in the list and clears the ones that worked', async () => {
    const calls = renderScreen((call) => {
      const email = (call.body as { email: string }).email;
      return email === 'maya@northstar.studio'
        ? issued(email, 'tok')
        : // The real envelope: `{ error: { code, message, correlationId } }`. A bare
          // `{ code, message }` would parse to the fallback message, so this asserts the
          // screen shows what the API actually said rather than a generic string.
          json(
            {
              error: {
                code: 'conflict',
                message: 'That address already has a pending invitation',
                correlationId: 'correlation-fixed',
              },
            },
            409,
          );
    });

    await add('maya@northstar.studio');
    await add('sara@northstar.studio');
    await userEvent.click(screen.getByRole('button', { name: 'Create 2 invitations' }));

    // One succeeded, one did not, and both are reported. The failure stays in the list so a
    // retry does not re-send the one that worked.
    expect(await screen.findByText(/already has a pending invitation/)).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    });
    expect(screen.getByRole('button', { name: 'Create 1 invitation' })).toBeInTheDocument();
  });

  it('has no axe violations after sending', async () => {
    const { container } = render(
      <InviteTeamScreen
        signedInAs="omar@northstar.studio"
        organizationSlug="northstar"
        organizationDomain="northstar.studio"
        existingMembers={[]}
        client={clientOver(() => issued('maya@northstar.studio', 'tok')).client}
      />,
    );

    await add('maya@northstar.studio');
    await userEvent.click(screen.getByRole('button', { name: 'Create 1 invitation' }));
    await screen.findByText('Links to send');
    await expectNoAxeViolations(container);
  });
});
