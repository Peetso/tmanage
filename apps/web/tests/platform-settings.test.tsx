import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { PlatformMeView } from '../src/lib/api/platform-admin';
import type {
  PlatformFlagView,
  PlatformIntegrationsView,
  PlatformSettingsFullView,
} from '../src/lib/api/platform-settings';
import type { PlatformMaintenanceListView } from '../src/lib/api/maintenance';
import { PlatformGeneralSettingsScreen } from '../src/components/platform/settings/PlatformGeneralSettingsScreen';
import {
  PlatformFlagsScreen,
  filterFlags,
} from '../src/components/platform/settings/PlatformFlagsScreen';
import { PlatformAnnouncementsScreen } from '../src/components/platform/settings/PlatformAnnouncementsScreen';
import {
  PlatformMaintenanceScreen,
  countdown,
} from '../src/components/platform/settings/PlatformMaintenanceScreen';
import { PlatformAnnouncementBanner } from '../src/components/platform/announcements/PlatformAnnouncementBanner';
import { fill } from '../src/components/platform/settings/settings-kit';

/** platform-admin v2 · PA-10 — D1 general, D2 flags, D3 announcements, D4 maintenance, banner. */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME: PlatformMeView = {
  email: 'peter@peetrix.com',
  displayName: 'Peter',
  mfaEnabled: true,
  stepUpExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  stepUpMinutes: 15,
  source: 'env',
  preset: 'super_admin',
  permissions: [
    'platform.orgs.view',
    'platform.settings.edit',
    'platform.flags.edit',
    'platform.announcements.edit',
  ],
  supportSessions: [],
};

const NEVER = { at: null, by: null };
const SETTINGS: PlatformSettingsFullView = {
  publicSignup: { open: true, source: 'environment', environmentDefault: true },
  aiAccess: { on: true, environmentDisabled: false },
  billingMode: {
    mode: 'beta_free',
    source: 'environment',
    environmentDefault: 'beta_free',
    organizationCount: 124,
    overrideCount: 4,
  },
  betaBanner: { on: true, textEn: 'TManage is in free beta', textAr: '' },
  retention: { orgPurgeDays: 30, userPurgeDays: 30, contentPurgeDays: 30 },
  supportDefaults: { maxMinutes: 480, requireReason: false },
  stepUpMinutes: 15,
  changes: {
    publicSignup: { at: '2026-10-21T18:42:00Z', by: 'Peter' },
    aiAccess: NEVER,
    billingMode: NEVER,
    betaBanner: NEVER,
    retention: NEVER,
    supportDefaults: NEVER,
  },
};
const INTEGRATIONS: PlatformIntegrationsView = {
  integrations: [
    {
      key: 'google_drive',
      configured: true,
      missingEnvironment: [],
      enabled: true,
      environmentForcedOff: false,
      connectedOrganizations: 41,
      lastErrorCode: null,
      lastErrorAt: null,
      lastSuccessAt: null,
    },
    {
      key: 'microsoft_calendar',
      configured: false,
      missingEnvironment: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
      enabled: false,
      environmentForcedOff: false,
      connectedOrganizations: 0,
      lastErrorCode: null,
      lastErrorAt: null,
      lastSuccessAt: null,
    },
  ],
};

function flag(overrides: Partial<PlatformFlagView>): PlatformFlagView {
  return {
    key: 'chat',
    enabled: true,
    rollout: 'everyone',
    percentage: null,
    allowlistOrganizationIds: [],
    codeDefault: true,
    lockedValue: null,
    forcedOn: 0,
    forcedOff: 0,
    usedByOrganizations: 3,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}
const FLAGS = {
  organizationCount: 3,
  flags: [
    flag({ key: 'chat' }),
    flag({ key: 'copilot', enabled: false, codeDefault: false, usedByOrganizations: 0 }),
    flag({ key: 'billing', lockedValue: false }),
  ],
};

type Route = (method: string, path: string, body: unknown) => Response | undefined;

function mount(ui: (client: ApiClient) => ReactNode, route: Route) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('https://api.example.test', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === '/v1/platform/me') return Promise.resolve(json(ME));
    const answer = route(method, path, body);
    return Promise.resolve(answer ?? json({ error: { code: 'not_found', message: 'x' } }, 404));
  }) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui(client)}
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

describe('D1 · Platform settings — General', () => {
  const route: Route = (method, path) => {
    if (path === '/v1/platform/settings') return json(SETTINGS);
    if (path === '/v1/platform/settings/integrations') return json(INTEGRATIONS);
    if (method === 'PUT' && path === '/v1/platform/settings/billing-mode') {
      return json({ ...SETTINGS, billingMode: { ...SETTINGS.billingMode, mode: 'paid' } });
    }
    return undefined;
  };

  it('renders every card, the AI access anchor and the integrations table', async () => {
    mount((client) => <PlatformGeneralSettingsScreen client={client} />, route);
    expect(await screen.findByRole('heading', { name: 'Sign-up' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Billing mode' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Retention — restore window' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Support sessions' })).toBeTruthy();
    expect(document.getElementById('ai-access')).not.toBeNull();
    expect(await screen.findByText('Google Drive')).toBeTruthy();
    expect(screen.getByText('Add MICROSOFT_CLIENT_ID in Hostinger')).toBeTruthy();
    expect(screen.getByText(/affects 124 organizations/u)).toBeTruthy();
  });

  it('switching billing mode to Paid needs a reason, then PUTs it', async () => {
    const calls = mount((client) => <PlatformGeneralSettingsScreen client={client} />, route);
    fireEvent.click(await screen.findByRole('radio', { name: /Paid/u }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Switch billing mode to Paid?')).toBeTruthy();
    expect(within(dialog).getByText('120 organizations move to Paid')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to Paid' }));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Beta ends on 1 Dec 2026' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch to Paid' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: '/v1/platform/settings/billing-mode',
        body: { mode: 'paid', reason: 'Beta ends on 1 Dec 2026' },
      }),
    );
  });

  it('shows the load error with Try again', async () => {
    mount(
      (client) => <PlatformGeneralSettingsScreen client={client} />,
      (_method, path) =>
        path === '/v1/platform/settings'
          ? json(
              { error: { code: 'service_unavailable', message: 'The server did not answer' } },
              503,
            )
          : undefined,
    );
    expect(await screen.findByText("We couldn't load the platform settings")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('D2 · Feature flags', () => {
  it('filters by locked and edits a flag with an allowlist', async () => {
    expect(filterFlags(FLAGS.flags, 'locked').map((row) => row.key)).toEqual(['billing']);
    expect(filterFlags(FLAGS.flags, 'off').map((row) => row.key)).toEqual(['copilot', 'billing']);
    const calls = mount(
      (client) => <PlatformFlagsScreen client={client} />,
      (method, path) => {
        if (path === '/v1/platform/flags') return json(FLAGS);
        if (path.startsWith('/v1/platform/flags/copilot/organizations')) {
          return json({ key: 'copilot', organizations: [] });
        }
        if (method === 'PUT' && path === '/v1/platform/flags/copilot') return json(FLAGS);
        return undefined;
      },
    );
    expect(await screen.findByText('AI copilot (Ask)')).toBeTruthy();
    const rows = screen.getAllByRole('button', { name: 'Edit' });
    // chat, copilot, billing (locked: disabled)
    expect((rows[2] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(rows[1] as HTMLElement);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Percentage' }));
    fireEvent.change(within(dialog).getByLabelText('Percentage of organizations'), {
      target: { value: '25' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save flag' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: '/v1/platform/flags/copilot',
        body: { enabled: false, rollout: 'percentage', percentage: 25 },
      }),
    );
  });
});

describe('D3 · Announcements', () => {
  it('shows the empty state with New announcement', async () => {
    mount(
      (client) => <PlatformAnnouncementsScreen client={client} />,
      (_method, path) =>
        path === '/v1/platform/announcements' ? json({ announcements: [] }) : undefined,
    );
    expect(await screen.findByText('Nothing is being announced')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New announcement' }).length).toBeGreaterThan(0);
  });

  it('publishes a new announcement written in English and Arabic', async () => {
    const calls = mount(
      (client) => <PlatformAnnouncementsScreen client={client} />,
      (method, path) => {
        if (method === 'GET' && path === '/v1/platform/announcements')
          return json({ announcements: [] });
        if (method === 'POST' && path === '/v1/platform/announcements') return json({}, 201);
        return undefined;
      },
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'New announcement' }))[0] as HTMLElement,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Planned maintenance' } });
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Read-only from 22:00' },
    });
    fireEvent.change(screen.getByLabelText('العنوان'), { target: { value: 'صيانة مجدولة' } });
    expect(screen.getAllByTestId('platform-announcement')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')).toMatchObject({
        body: {
          titleEn: 'Planned maintenance',
          titleAr: 'صيانة مجدولة',
          bodyEn: 'Read-only from 22:00',
          audience: 'everyone',
          published: true,
        },
      }),
    );
  });
});

describe('D4 · Maintenance mode', () => {
  const ACTIVE = {
    id: '0199aa00-0000-7000-8000-0000000000f1',
    message: 'TManage is down for an upgrade',
    messageAr: null,
    severity: 'down' as const,
    startsAt: new Date(Date.now() - 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 3600_000).toISOString(),
    published: true,
    blockSignIn: true,
    state: 'active' as const,
    endedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  };
  const LIST: PlatformMaintenanceListView = { windows: [ACTIVE], current: ACTIVE, asOf: '' };

  it('shows the active window and ends it now', async () => {
    const calls = mount(
      (client) => <PlatformMaintenanceScreen client={client} />,
      (method, path) => {
        if (path === '/v1/platform/maintenance') return json(LIST);
        if (method === 'POST' && path.endsWith('/end')) return json({ ...ACTIVE, state: 'ended' });
        return undefined;
      },
    );
    const card = await screen.findByTestId('maintenance-active');
    expect(
      within(card).getByText(/sign-in is blocked for everyone except platform admins/u),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'End now' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('End maintenance now?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'End now' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')).toMatchObject({
        path: `/v1/platform/maintenance/${ACTIVE.id}/end`,
      }),
    );
  });

  it('formats the countdown', () => {
    expect(countdown(new Date(5_048_000).toISOString(), 0)).toBe('1:24:08');
    expect(countdown(new Date(0).toISOString(), 10_000)).toBe('0:00:00');
  });
});

describe('PlatformAnnouncementBanner', () => {
  it('renders the Arabic banner right-to-left and remembers a dismissal', async () => {
    const banner = {
      id: 'a1',
      locale: 'ar',
      title: 'صيانة مجدولة',
      body: 'للقراءة فقط',
      severity: 'warning',
      linkUrl: null,
      dismissible: true,
      endsAt: null,
    };
    mount(
      (client) => <PlatformAnnouncementBanner client={client} />,
      (_method, path) =>
        path.startsWith('/public/site/announcements')
          ? json({ announcement: banner, asOf: '' })
          : undefined,
    );
    const shown = await screen.findByTestId('platform-announcement');
    expect(shown.getAttribute('dir')).toBe('rtl');
    fireEvent.click(within(shown).getByRole('button'));
    expect(screen.queryByTestId('platform-announcement')).toBeNull();
    expect(window.localStorage.getItem('tm.platformAnnouncement.dismissed')).toContain('a1');
  });

  it('fills placeholders', () => {
    expect(fill('{count} of {total}', { count: 2, total: 5 })).toBe('2 of 5');
  });
});
