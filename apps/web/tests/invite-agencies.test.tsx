import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { InviteAgenciesScreen } from '../src/components/screens/InviteAgenciesScreen';
import {
  mayOpenSection,
  controlCenterSectionsFor,
} from '../src/components/admin/ControlCenterShell';
import { ApiClient } from '../src/lib/api/client';
import { inviteLinkFor, referralCodeFromQuery } from '../src/lib/api/referrals';
import { localizedInviteLink } from '../src/lib/referral-invite-link';
import type { ReferralView } from '../src/lib/api/referrals';
import { INVITE_AGENCIES_RETURN, safeReturnPath } from '../src/lib/sign-in-return';

/** 57-08 REFERRAL — Settings › People › Invite agencies, and the sign-up carry. */

function clientWith(routes: (method: string, url: string) => { status: number; body: unknown }) {
  const calls: { method: string; url: string }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url });
      const { status, body } = routes(method, url);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  return { client, calls };
}

function wrap(node: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={query}>{node}</QueryClientProvider>);
}

const BASE = 'https://api.example.test/v1/organizations/northstar/referral';

const VIEW: ReferralView = {
  code: 'northstar-7q4k2m',
  signedUp: 2,
  agencies: [
    { name: 'Cedar Agency', signedUpAt: '2026-11-12T10:00:00.000Z' },
    { name: 'Blue Dune Studio', signedUpAt: '2026-11-10T10:00:00.000Z' },
  ],
  rewards: null,
};

function screenFor(client: ApiClient) {
  return wrap(
    <InviteAgenciesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={client}
      origin="https://tmanageapp.com"
    />,
  );
}

describe('InviteAgenciesScreen (57-08 REFERRAL)', () => {
  it('shows the link (LTR), one "signed up" tile and the agencies — never an address or an invited count', async () => {
    const { client } = clientWith(() => ({ status: 200, body: VIEW }));
    const { container } = screenFor(client);
    const link = await screen.findByText('https://tmanageapp.com/sign-up?ref=northstar-7q4k2m');
    expect(link.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('Companies signed up')).toBeTruthy();
    expect(screen.getByText('Cedar Agency')).toBeTruthy();
    expect(screen.getByText('Blue Dune Studio')).toBeTruthy();
    expect(screen.getAllByText('Signed up')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/invited/iu);
    // Beta: no reward line.
    expect(text).not.toContain('Account credit');
  });

  it('shows the recorded credit only when the API sends it (outside the beta)', async () => {
    const { client } = clientWith(() => ({
      status: 200,
      body: { ...VIEW, rewards: { recorded: 2 } },
    }));
    screenFor(client);
    expect(await screen.findByText('Account credit recorded: 2')).toBeTruthy();
  });

  it('creates the link once on the first visit', async () => {
    const { client, calls } = clientWith((method) =>
      method === 'POST'
        ? { status: 200, body: VIEW }
        : { status: 200, body: { ...VIEW, code: null, signedUp: 0, agencies: [] } },
    );
    screenFor(client);
    await screen.findByText('https://tmanageapp.com/sign-up?ref=northstar-7q4k2m');
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      `${BASE}/code`,
    ]);
  });

  it('tells anyone but the owner, in words, that the page is the owner’s', async () => {
    const { client } = clientWith(() => ({
      status: 403,
      body: { error: { code: 'forbidden', message: 'No', correlationId: 'c' } },
    }));
    screenFor(client);
    expect(
      await screen.findByText('Only the workspace owner can use the invite link.'),
    ).toBeTruthy();
  });
});

describe('Invite agencies menu entry (People, owner only)', () => {
  it('is drawn for the owner, under Invitations, and not for an organization admin', () => {
    const people =
      controlCenterSectionsFor('owner')
        .groups.map((group) => group.items.map((item) => item.id))
        .find((ids) => ids.includes('invitations')) ?? [];
    expect(people.slice(people.indexOf('invitations'), people.indexOf('invitations') + 2)).toEqual([
      'invitations',
      'invite-agencies',
    ]);
    const entry = {
      id: 'invite-agencies',
      ownerOnly: true,
      capability: 'org.manage',
    } as Parameters<typeof mayOpenSection>[1];
    expect(mayOpenSection('owner', entry)).toBe(true);
    expect(mayOpenSection('org_admin', entry)).toBe(false);
    expect(mayOpenSection('member', entry)).toBe(false);
  });
});

describe('sign-up carry', () => {
  it('sends only a code-shaped ?ref=', () => {
    expect(referralCodeFromQuery('Northstar-7q4k2m')).toBe('northstar-7q4k2m');
    expect(referralCodeFromQuery('p.cedar-agency-4k2m9q')).toBe('p.cedar-agency-4k2m9q');
    for (const bad of [null, '', 'x', '<script>', 'https://evil.test', 'a b-abcdef']) {
      expect(referralCodeFromQuery(bad)).toBeNull();
    }
    expect(inviteLinkFor('https://tmanageapp.com/', 'northstar-7q4k2m')).toBe(
      'https://tmanageapp.com/sign-up?ref=northstar-7q4k2m',
    );
    // TESTUX P1 12: an Arabic owner's link opens the Arabic sign-up, with the same code.
    expect(localizedInviteLink('https://tmanageapp.com', 'northstar-7q4k2m', 'ar-EG')).toBe(
      'https://tmanageapp.com/ar/sign-up?ref=northstar-7q4k2m',
    );
    expect(localizedInviteLink('https://tmanageapp.com', 'northstar-7q4k2m', 'fr-FR')).toBe(
      'https://tmanageapp.com/sign-up?ref=northstar-7q4k2m',
    );
  });

  it('lets sign-in return to the invite page through the workspace picker', () => {
    expect(safeReturnPath(INVITE_AGENCIES_RETURN)).toBe(INVITE_AGENCIES_RETURN);
  });
});
