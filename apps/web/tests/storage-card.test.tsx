import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { StorageMoveView, StorageOnTManageView } from '../src/lib/api/storage-root';
import type { PlanStorageView, StorageThreshold } from '../src/lib/api/plan-usage';
import { StorageCard } from '../src/components/billing/StorageCard';
import { PlanUsageScreen } from '../src/components/screens/PlanUsageScreen';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/** 57-13c — "Where your files live" (Figma 668:36868): one test per card state. */
// jsdom has no modal dialogs; opening one is what the card asks of the browser.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
const JOBS = '/integrations/storage/migration-jobs';

function job(overrides: Partial<StorageMoveView>): StorageMoveView {
  return {
    id: '01933b4e-0000-7000-8000-000000000001',
    provider: 'google_drive',
    status: 'running',
    total: 1240,
    moved: 312,
    failed: 0,
    skipped: 0,
    movedBytes: 1.1 * 1024 ** 3,
    totalBytes: 3.4 * 1024 ** 3,
    error: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function drive(connected: boolean) {
  return {
    configured: true,
    pickerAvailable: true,
    storageMode: connected ? 'google_drive' : 'tmanage',
    googleDrive: {
      status: connected ? 'connected' : 'not_connected',
      accountEmail: connected ? 'studio@alnoor.sa' : null,
      folderPath: null,
      sharedDriveName: null,
      rootOwner: null,
    },
  };
}

const ONEDRIVE_OFF = {
  configured: true,
  pickerAvailable: true,
  storageMode: 'tmanage',
  oneDrive: {
    status: 'not_connected',
    accountEmail: null,
    folderPath: null,
    driveName: null,
    librariesEnabled: false,
    rootOwner: null,
  },
};

function client(routes: Record<string, unknown>, calls: string[]) {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      calls.push(key);
      const match = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((route) => key.includes(route));
      return Promise.resolve(
        new Response(JSON.stringify(match ? routes[match] : {}), {
          status: match ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
}

const ON_TMANAGE: StorageOnTManageView = { files: 1240, bytes: 3.4 * 1024 ** 3, movable: 1240 };

function mount(
  latest: StorageMoveView | null,
  connected = true,
  started?: StorageMoveView,
  onTManage: StorageOnTManageView = ON_TMANAGE,
  allowance: PlanStorageView | null = null,
) {
  const calls: string[] = [];
  const api = client(
    {
      [`GET https://api.example.test/v1/organizations/northstar${JOBS}`]: {
        job: latest,
        onTManage,
      },
      [`POST https://api.example.test/v1/organizations/northstar${JOBS}`]: started ?? {},
      '/google-drive': drive(connected),
      '/onedrive': ONEDRIVE_OFF,
    },
    calls,
  );
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <StorageCard organizationSlug="northstar" client={api} allowance={allowance} />
    </QueryClientProvider>,
  );
  return calls;
}

function renderAllowance(allowance: PlanStorageView) {
  const api = client(
    {
      [`GET https://api.example.test/v1/organizations/northstar${JOBS}`]: {
        job: null,
        onTManage: ON_TMANAGE,
      },
      '/google-drive': drive(false),
      '/onedrive': ONEDRIVE_OFF,
    },
    [],
  );
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <StorageCard organizationSlug="northstar" client={api} allowance={allowance} />
    </QueryClientProvider>,
  );
}

describe('StorageCard', () => {
  it('S1: nothing connected offers the two connect links to Integrations', async () => {
    mount(null, false);
    const google = await screen.findByRole('link', { name: 'Connect Google Drive' });
    expect(google.getAttribute('href')).toBe('/northstar/automations/apps');
    expect(screen.getByRole('link', { name: 'Connect OneDrive' })).toBeTruthy();
    expect(screen.getByText('Temporary storage on TManage')).toBeTruthy();
    expect(screen.getByText('3.4 GB')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('57-13r: before Drive, a labelled allowance bar and a notice at 70, 85, 95 and 100 %', async () => {
    const GB = 1024 ** 3;
    const steps: [StorageThreshold, number, RegExp][] = [
      [70, 72, /^72% of your temporary storage is used\. Connect Google Drive or OneDrive so/],
      [85, 88, /^88% of your temporary storage is used\. Connect Google Drive or OneDrive soon/],
      [95, 96, /^Your temporary storage is almost full \(96%\)/],
      [100, 100, /New uploads wait until you connect .* Nothing is deleted\.$/],
    ];
    for (const [threshold, percent, notice] of steps) {
      const allowance: PlanStorageView = {
        used: (percent / 100) * GB,
        limit: GB,
        level: 'near',
        percent,
        threshold,
        raisedBySupport: false,
      };
      const { unmount } = renderAllowance(allowance);
      expect(await screen.findByText(notice)).toBeTruthy();
      const bar = screen.getByRole('progressbar', { name: 'Temporary storage on TManage' });
      expect(bar.getAttribute('aria-valuetext')).toMatch(
        new RegExp(`^${percent}% of the temporary storage on TManage is in use`),
      );
      expect(screen.getByRole('link', { name: 'Connect Google Drive' })).toBeTruthy();
      unmount();
    }
  });

  it('S2: connected shows where files live and the one Move button', async () => {
    mount(null);
    expect(await screen.findByText('Files live in: Google Drive (studio@alnoor.sa)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move files to Google Drive' })).toBeTruthy();
    expect(screen.getByText('Still in temporary storage')).toBeTruthy();
  });

  it('S2: nothing left to move shows the amount and no Move button', async () => {
    mount(null, true, undefined, { files: 0, bytes: 0, movable: 0 });
    expect(await screen.findByText('0 B')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('S3: confirm asks first, Cancel starts nothing, Move files starts the job', async () => {
    const calls = mount(null, true, job({ status: 'queued', moved: 0, movedBytes: 0 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Move files to Google Drive' }));
    const dialog = screen.getByRole('dialog', { name: 'Move 1,240 files to Google Drive?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Move files to Google Drive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move files' }));
    expect(await screen.findByText('0 of 1,240 files moved')).toBeTruthy();
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
  });

  it('S4: running shows files moved, size and a labelled bar', async () => {
    mount(job({}));
    expect(await screen.findByText('312 of 1,240 files moved')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: '312 of 1,240 files moved' });
    expect(bar.getAttribute('aria-valuenow')).toBe('312');
    expect(screen.getByText('1.1 GB of 3.4 GB')).toBeTruthy();
  });

  it('S5: finished shows the success notice, 0 B and plain count lines', async () => {
    mount(job({ status: 'done', moved: 1236, skipped: 3, failed: 0 }), true, undefined, {
      files: 3,
      bytes: 0,
      movable: 0,
    });
    expect(await screen.findByText('All done. Your files now live in Google Drive.')).toBeTruthy();
    expect(screen.getByText('1,236 files moved.')).toBeTruthy();
    expect(screen.getByText(/^3 files stayed on TManage/)).toBeTruthy();
    expect(screen.getByText('0 B')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('S5: failed files are named with Try again, which asks before a new move', async () => {
    mount(job({ status: 'done', moved: 1236, failed: 1 }), true, undefined, {
      files: 1,
      bytes: 2048,
      movable: 1,
    });
    expect(await screen.findByText('1 file could not be moved. Try again moves it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('dialog', { name: 'Move 1 file to Google Drive?' })).toBeTruthy();
  });

  it('S6: each stop reason has its calm notice and one way forward', async () => {
    mount(job({ status: 'stopped', error: 'not_connected' }));
    expect(await screen.findByText(/no longer connected/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Google Drive' })).toBeTruthy();
  });

  it('S6: provider unavailable offers Try again, which starts a new job', async () => {
    const calls = mount(job({ status: 'stopped', error: 'provider_unavailable' }), true, job({}));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('312 of 1,240 files moved')).toBeTruthy();
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
  });

  it('S6: a changed account asks to reconnect the account it started with', async () => {
    mount(job({ status: 'stopped', error: 'connection_changed' }));
    expect(await screen.findByText(/A different Google account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect' })).toBeTruthy();
  });
});

describe('PlanUsageScreen storage card', () => {
  it('S7: is not rendered for someone without org.security.manage', async () => {
    const calls: string[] = [];
    const api = client(
      {
        '/billing/plan-usage': {
          billingMode: 'beta_free',
          people: { used: 3, limit: null, level: 'normal' },
        },
      },
      calls,
    );
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    query.setQueryData(['shell', 'organizations'], [{ slug: 'northstar', role: 'member' }]);
    render(
      <QueryClientProvider client={query}>
        <PlanUsageScreen organizationSlug="northstar" organizationName="Northstar" client={api} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls.some((call) => call.includes('/plan-usage'))).toBe(true));
    expect(screen.queryByText('Where your files live')).toBeNull();
    expect(calls.some((call) => call.includes(JOBS))).toBe(false);
  });
});
