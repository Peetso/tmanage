import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MyDataScreen } from '../src/components/screens/MyDataScreen';
import { PrivacyScreen } from '../src/components/screens/PrivacyScreen';
import type { MyPrivacyView, PrivacyExportView, PrivacyOverviewView } from '../src/lib/api/privacy';
import {
  confirmsName,
  isSameDay,
  privacyClock,
  privacyDay,
  privacySize,
  progressShare,
} from '../src/lib/privacy-presentation';

/** D5 (Figma F5): the Privacy page and My data, over a fake API. */

const NOW = new Date('2026-10-25T13:30:00.000Z');
const MAYA = { userId: 'u1', displayName: 'Maya Hassan' };
const SARA = { userId: 'u2', displayName: 'Sara Ali' };

function exportRow(overrides: Partial<PrivacyExportView>): PrivacyExportView {
  return {
    id: 'e1',
    kind: 'company',
    state: 'ready',
    progressPercent: 100,
    sizeBytes: 2_400_000_000,
    scanStatus: 'clean',
    requestedAt: '2026-10-25T10:42:00.000Z',
    completedAt: '2026-10-25T13:05:00.000Z',
    expiresAt: '2026-11-01T13:05:00.000Z',
    requestedBy: MAYA,
    subject: null,
    ...overrides,
  };
}

function overview(overrides: Partial<PrivacyOverviewView> = {}): PrivacyOverviewView {
  return {
    organizationName: 'Northstar Studio',
    memberCount: 24,
    gracePeriodDays: 30,
    linkDays: 7,
    companyExports: [],
    memberExports: [],
    members: [
      {
        membershipId: 'm2',
        userId: 'u2',
        displayName: 'Sara Ali',
        jobTitle: 'Designer',
        role: 'member',
      },
    ],
    deletion: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: string | null;
}

function clientFor(routes: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      const { status, body } = routes(call);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
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

const notFound = {
  status: 404,
  body: { error: { code: 'not_found', message: 'Not found.', correlationId: 'c' } },
};

function mountPrivacy(routes: (call: Call) => { status: number; body?: unknown } | undefined) {
  const { client, calls } = clientFor((call) => routes(call) ?? notFound);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <PrivacyScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
        baseUrl="https://api.example.test"
        now={() => NOW}
      />
    </QueryClientProvider>,
  );
  return calls;
}

describe('Privacy page', () => {
  it('shows a ready company export with its link and size, as the frame does', async () => {
    mountPrivacy((call) =>
      call.url.endsWith('/admin/privacy')
        ? { status: 200, body: overview({ companyExports: [exportRow({})] }) }
        : undefined,
    );
    expect(await screen.findByText('Ready to download')).toBeTruthy();
    expect(
      // The clock is read in the runtime's zone, as the page reads it.
      screen.getByText(
        `2.4 GB · made today at ${privacyClock('2026-10-25T13:05:00.000Z')}. The download link works until ${privacyDay('2026-11-01T13:05:00.000Z', 'en-US')}.`,
      ),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('href')).toBe(
      'https://api.example.test/v1/organizations/northstar/admin/privacy/exports/e1/download',
    );
  });

  it('disables Request export while one is being prepared, and shows the progress', async () => {
    mountPrivacy((call) =>
      call.url.endsWith('/admin/privacy')
        ? {
            status: 200,
            body: overview({
              companyExports: [
                exportRow({ state: 'preparing', progressPercent: 40, completedAt: null }),
              ],
            }),
          }
        : undefined,
    );
    expect(await screen.findByText('About 40% done')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Request export' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('asks for the exact company name before requesting deletion', async () => {
    const calls = mountPrivacy((call) => {
      if (call.url.endsWith('/admin/privacy/deletion')) {
        return {
          status: 200,
          body: overview({
            deletion: {
              id: 'd1',
              kind: 'company',
              requestedAt: NOW.toISOString(),
              scheduledFor: '2026-11-24T13:30:00.000Z',
              daysLeft: 30,
              requestedBy: MAYA,
            },
          }),
        };
      }
      return call.url.endsWith('/admin/privacy') ? { status: 200, body: overview() } : undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Request deletion' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Northstar Studio?' });
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (node) => node.textContent === 'Request deletion',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type Northstar Studio to confirm'), {
      target: { value: 'Northstar Studio' },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await screen.findByText('Requested today by Maya Hassan · 30 days left')).toBeTruthy();
    const write = calls.find((call) => call.method === 'POST');
    expect(write?.body).toBe(JSON.stringify({ confirmName: 'Northstar Studio' }));
  });

  it('lists member exports with their state and an Ask again for an expired one', async () => {
    mountPrivacy((call) =>
      call.url.endsWith('/admin/privacy')
        ? {
            status: 200,
            body: overview({
              memberExports: [
                exportRow({
                  id: 'e2',
                  kind: 'member',
                  state: 'expired',
                  subject: SARA,
                  expiresAt: '2026-10-20T10:00:00.000Z',
                }),
              ],
            }),
          }
        : undefined,
    );
    expect(await screen.findByText('Expired on 20 Oct 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again Sara Ali' }));
    expect(await screen.findByRole('dialog', { name: "Export a member's data" })).toBeTruthy();
  });

  it('tells a non-owner, in words, that the page is for owners', async () => {
    mountPrivacy((call) =>
      call.url.endsWith('/admin/privacy')
        ? {
            status: 403,
            body: { error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } },
          }
        : undefined,
    );
    expect(await screen.findByText('Only company owners can use this page.')).toBeTruthy();
  });
});

describe('My data', () => {
  function mountMine(body: MyPrivacyView) {
    const { client } = clientFor((call) =>
      call.url.endsWith('/me/privacy') ? { status: 200, body } : notFound,
    );
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <MyDataScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
          baseUrl="https://api.example.test"
          now={() => NOW}
        />
      </QueryClientProvider>,
    );
  }

  it('offers the ready file and the cancel while a deletion is scheduled', async () => {
    mountMine({
      organizationName: 'Northstar Studio',
      gracePeriodDays: 30,
      linkDays: 7,
      export: exportRow({ kind: 'member', subject: MAYA, sizeBytes: 120_000_000 }),
      deletion: {
        id: 'd1',
        kind: 'account',
        requestedAt: NOW.toISOString(),
        scheduledFor: '2026-11-24T13:30:00.000Z',
        daysLeft: 30,
        requestedBy: MAYA,
      },
    });
    expect(await screen.findByText('Ready to download · 120 MB')).toBeTruthy();
    expect(
      screen.getByText(
        'Your account will be deleted on 24 Nov 2026. You can still sign in and work until then.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
      '/me/privacy/exports/e1/download',
    );
  });
});

describe('privacy presentation', () => {
  it('reads dates, clocks and sizes the way the frame writes them', () => {
    expect(privacyDay('2026-11-01T13:05:00.000Z', 'en-US', 'UTC')).toBe('1 Nov 2026');
    expect(privacyDay('2026-11-01T13:05:00.000Z', 'ar-EG', 'UTC')).toBe('1 نوفمبر 2026');
    expect(privacyClock('2026-10-25T13:05:00.000Z', 'UTC')).toBe('13:05');
    expect(isSameDay('2026-10-25T01:00:00.000Z', NOW, 'UTC')).toBe(true);
    expect(isSameDay('2026-10-24T23:00:00.000Z', NOW, 'UTC')).toBe(false);
    expect(privacySize(2_400_000_000)).toBe('2.4 GB');
    expect(privacySize(120_000_000)).toBe('120 MB');
    expect(privacySize(null)).toBe('');
    expect(progressShare(0)).toBe(4);
    expect(progressShare(140)).toBe(100);
  });

  it('confirms only the exact company name', () => {
    expect(confirmsName(' Northstar Studio ', 'Northstar Studio')).toBe(true);
    expect(confirmsName('Northstar', 'Northstar Studio')).toBe(false);
    expect(confirmsName('', '')).toBe(false);
  });
});
