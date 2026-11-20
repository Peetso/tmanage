import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { PlatformMeView } from '../src/lib/api/platform-admin';
import { recentQuarters } from '../src/lib/api/platform-governance';
import type {
  PlatformAccessReviewView,
  PlatformApprovalsView,
} from '../src/lib/api/platform-governance';
import {
  PlatformAccessReviewScreen,
  PlatformApprovalsScreen,
  PlatformOwnerNoticesScreen,
} from '../src/components/platform/governance/PlatformGovernanceScreens';

/** R46 L2 — platform governance (56-21). The Slack/Teams channel notices were removed (FIX5). */

type Answer = { status: number; body: unknown };

function recording(routes: Record<string, Answer>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const answer = routes[`${method} ${url.pathname}`] ??
        routes[url.pathname] ?? {
          status: 404,
          body: { error: { code: 'not_found', message: 'x' } },
        };
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  return { client, calls };
}

function wrap(node: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [
      {
        id: 'o1',
        slug: 'northstar',
        name: 'Northstar Studio',
        audience: 'internal',
        role: 'owner',
      },
    ],
  );
  return render(<QueryClientProvider client={queries}>{node}</QueryClientProvider>);
}

function me(overrides: Partial<PlatformMeView> = {}): PlatformMeView {
  return {
    email: 'peter@peetrix.com',
    displayName: 'Peter',
    mfaEnabled: true,
    stepUpNeedsAuthenticatorCode: true,
    stepUpExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    stepUpMinutes: 15,
    source: 'env',
    preset: 'super_admin',
    permissions: [
      'platform.orgs.view',
      'platform.orgs.edit',
      'platform.orgs.lifecycle',
      'platform.team.manage',
    ],
    supportSessions: [],
    ...overrides,
  };
}

const APPROVALS: PlatformApprovalsView = {
  policy: { enabled: true },
  actions: ['company.suspend', 'company.delete', 'company.transfer_ownership'],
  approvals: [
    {
      id: 'a-1',
      action: 'company.suspend',
      targetId: 'o-1',
      targetLabel: 'Acme Studio',
      reason: 'Unpaid for 60 days',
      status: 'pending',
      requestedByEmail: 'sara@tmanage.app',
      requestedAt: '2026-11-08T09:00:00.000Z',
      expiresAt: '2026-11-09T09:00:00.000Z',
      decidedByEmail: null,
      decidedAt: null,
      decisionNote: null,
      mine: false,
    },
    {
      id: 'a-2',
      action: 'company.delete',
      targetId: 'o-2',
      targetLabel: 'Beta Co',
      reason: 'Owner asked',
      status: 'pending',
      requestedByEmail: 'peter@peetrix.com',
      requestedAt: '2026-11-08T09:00:00.000Z',
      expiresAt: '2026-11-09T09:00:00.000Z',
      decidedByEmail: null,
      decidedAt: null,
      decisionNote: null,
      mine: true,
    },
  ],
};

describe('Platform approvals screen', () => {
  it('lets another admin approve, and never offers approve on your own request', async () => {
    const { client } = recording({
      '/v1/platform/me': { status: 200, body: me() },
      '/v1/platform/approvals': { status: 200, body: APPROVALS },
    });
    wrap(<PlatformApprovalsScreen client={client} />);
    const table = await screen.findByRole('table', { name: 'Waiting for approval' });
    expect(within(table).getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(
      within(table).getByText('You asked for this one. Another admin must approve it.'),
    ).toBeTruthy();
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
  });
});

describe('Owner notice screen', () => {
  it('requires a company, a subject and a message before sending', async () => {
    const { client, calls } = recording({
      '/v1/platform/me': { status: 200, body: me() },
      '/v1/platform/companies': { status: 200, body: { companies: [] } },
      '/v1/platform/owner-notices': { status: 200, body: { notices: [] } },
    });
    wrap(<PlatformOwnerNoticesScreen client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send notice' }));
    expect((await screen.findAllByText('Required')).length).toBeGreaterThanOrEqual(2);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('Quarterly access review screen', () => {
  const REVIEW: PlatformAccessReviewView = {
    month: '2026-Q4',
    from: '2026-10-01T00:00:00.000Z',
    to: '2027-01-01T00:00:00.000Z',
    withoutTwoStep: 1,
    admins: [
      {
        userId: 'u-1',
        email: 'sara@tmanage.app',
        displayName: 'Sara Adel',
        source: 'db',
        preset: 'support',
        status: 'active',
        twoStep: true,
        signIns: 3,
        supportSessions: 1,
        organizationsEntered: 1,
        lastActiveAt: null,
        adminId: 'adm-1',
        permissions: ['platform.orgs.view', 'platform.people.view'],
        confirmed: false,
      },
      {
        userId: 'u-2',
        email: 'omar@tmanage.app',
        displayName: 'Omar Nabil',
        source: 'db',
        preset: 'auditor',
        status: 'active',
        twoStep: false,
        signIns: 0,
        supportSessions: 0,
        organizationsEntered: 0,
        lastActiveAt: null,
        adminId: 'adm-2',
        permissions: [],
        confirmed: true,
      },
    ],
  };

  it('offers the four latest quarters', () => {
    expect(recentQuarters(new Date('2026-11-08T00:00:00Z'))).toEqual([
      '2026-Q4',
      '2026-Q3',
      '2026-Q2',
      '2026-Q1',
    ]);
  });

  it('shows rights and two-step, and confirms one person for the quarter', async () => {
    const { client, calls } = recording({
      '/v1/platform/me': { status: 200, body: me() },
      'GET /v1/platform/team/access-review': { status: 200, body: REVIEW },
      'POST /v1/platform/team/access-review/confirm': {
        status: 201,
        body: { period: '2026-Q4', userId: 'u-1', confirmed: true },
      },
    });
    wrap(<PlatformAccessReviewScreen client={client} now={new Date('2026-11-08T00:00:00Z')} />);
    const table = await screen.findByRole('table', { name: 'Platform team access' });
    expect(await within(table).findByText('Confirmed')).toBeTruthy();
    expect(within(table).getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
    expect(screen.getByText(/People without two-step sign-in/u)).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Confirm' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toMatchObject({
      path: '/v1/platform/team/access-review/confirm',
      body: { period: '2026-Q4', userId: 'u-1' },
    });
  });
});
