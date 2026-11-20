import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { PlatformTeamScreen } from '../src/components/platform/team/PlatformTeamScreen';
import { PlatformPresetsScreen } from '../src/components/platform/team/PlatformPresetsScreen';
import type { PlatformMeView } from '../src/lib/api/platform-admin';
import type { PlatformPresetsView, PlatformTeamView } from '../src/lib/api/platform-team';

/** platform-admin v2 · PA-02 — D5 team list and D6 presets (frames 436:18889, 436:19614, 439:18886). */

const query = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const ALL = [
  'platform.orgs.view',
  'platform.orgs.edit',
  'platform.orgs.lifecycle',
  'platform.orgs.enter',
  'platform.people.view',
  'platform.people.edit',
  'platform.people.security',
  'platform.people.roles',
  'platform.content.view',
  'platform.content.moderate',
  'platform.activity.view',
  'platform.activity.detail',
  'platform.activity.export',
  'platform.settings.edit',
  'platform.flags.edit',
  'platform.announcements.edit',
  'platform.permissions.edit',
  'platform.team.manage',
];

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
    permissions: ALL,
    supportSessions: [],
    ...overrides,
  };
}

const TEAM: PlatformTeamView = {
  permissionCount: 18,
  superAdmins: 3,
  envSuperAdmins: 2,
  canManage: true,
  admins: [
    row({
      id: null,
      email: 'peter@peetrix.com',
      displayName: 'Peter',
      source: 'env',
      locked: true,
      self: true,
    }),
    row({
      id: null,
      email: 'mariam@peetrix.com',
      displayName: 'Mariam Hassan',
      source: 'env',
      locked: true,
    }),
    row({
      id: 'a-1',
      email: 'omar.nabil@peetrix.com',
      displayName: 'Omar Nabil',
      preset: 'auditor',
    }),
    row({
      id: 'a-2',
      email: 'lina.fawzy@peetrix.com',
      displayName: 'Lina Fawzy',
      status: 'disabled',
    }),
  ],
};

function row(
  partial: Partial<PlatformTeamView['admins'][number]>,
): PlatformTeamView['admins'][number] {
  return {
    id: 'x',
    userId: 'u',
    email: 'x@example.com',
    displayName: null,
    source: 'db',
    preset: 'super_admin',
    permissions: ALL,
    status: 'active',
    locked: false,
    self: false,
    addedByEmail: null,
    createdAt: null,
    disabledAt: null,
    disabledReason: null,
    lastStepUpAt: null,
    ...partial,
  };
}

function client(routes: Record<string, { status: number; body: unknown }>): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const answer = routes[path] ?? {
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
}

function renderScreen(node: React.ReactNode) {
  return render(<QueryClientProvider client={query()}>{node}</QueryClientProvider>);
}

describe('Platform admin team (D5)', () => {
  it('locks the server-list rows and the own row, and offers Enable on a disabled admin', async () => {
    const api = client({
      '/v1/platform/me': { status: 200, body: me() },
      '/v1/platform/team': { status: 200, body: TEAM },
    });
    renderScreen(<PlatformTeamScreen client={api} />);
    expect(await screen.findByText('Platform admin team')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Platform admins' });
    expect(within(table).getAllByText('Locked')).toHaveLength(2);
    expect(within(table).getByText('Your own row is read-only')).toBeTruthy();
    expect(within(table).getByText('Managed in Hostinger')).toBeTruthy();
    expect(within(table).getAllByText('Server list')).toHaveLength(2);
    expect(within(table).getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add platform admin' })).toBeTruthy();
    // The shell: seven sections and the step-up pill.
    for (const name of ['Overview', 'Organizations', 'People', 'Content', 'Activity', 'Settings']) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.getByTestId('platform-step-up-pill').textContent).toContain('Step-up valid');
  });

  it('refuses to disable without a reason (frame 436:19614)', async () => {
    const api = client({
      '/v1/platform/me': { status: 200, body: me() },
      '/v1/platform/team': { status: 200, body: TEAM },
    });
    renderScreen(<PlatformTeamScreen client={api} />);
    const table = await screen.findByRole('table', { name: 'Platform admins' });
    fireEvent.click(within(table).getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disable Omar Nabil?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable admin' }));
    expect(
      await within(dialog).findByText('A reason is required (5–500 characters).'),
    ).toBeTruthy();
  });

  it('shows the 403 state naming the missing permission', async () => {
    const api = client({
      '/v1/platform/me': {
        status: 200,
        body: me({ preset: 'support', source: 'db', permissions: ['platform.orgs.view'] }),
      },
      '/v1/platform/team': {
        status: 403,
        body: {
          error: {
            code: 'platform_permission_missing',
            message: "Your platform permissions don't include this.",
            details: [{ field: 'permission', message: 'platform.team.manage' }],
          },
        },
      },
    });
    renderScreen(<PlatformTeamScreen client={api} />);
    expect(await screen.findByText("Your platform permissions don't include this")).toBeTruthy();
    expect(screen.getByText('platform.team.manage')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add platform admin' })).toBeNull();
  });
});

describe('Platform permission presets (D6)', () => {
  it('fixes Super admin and marks an unsaved change', async () => {
    const support = ALL.filter(
      (key) =>
        ![
          'platform.orgs.lifecycle',
          'platform.activity.export',
          'platform.settings.edit',
          'platform.flags.edit',
          'platform.announcements.edit',
          'platform.team.manage',
        ].includes(key),
    );
    const presets: PlatformPresetsView = {
      canManage: true,
      allPermissions: ALL,
      presets: [
        { preset: 'super_admin', permissions: ALL, defaults: ALL, editable: false, adminCount: 3 },
        {
          preset: 'support',
          permissions: support,
          defaults: support,
          editable: true,
          adminCount: 2,
        },
        { preset: 'auditor', permissions: [], defaults: [], editable: true, adminCount: 1 },
        { preset: 'custom', permissions: [], defaults: [], editable: false, adminCount: 1 },
      ],
    };
    const api = client({
      '/v1/platform/me': { status: 200, body: me() },
      '/v1/platform/team': { status: 200, body: TEAM },
      '/v1/platform/team/presets': { status: 200, body: presets },
    });
    renderScreen(<PlatformPresetsScreen client={api} />);
    const box = await screen.findByLabelText('Support: Activity · export CSV');
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByLabelText('Super admin: Activity · export CSV') as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(box);
    expect(await screen.findByText(/1 unsaved change/u)).toBeTruthy();
  });
});
