import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { StorageUsageScreen } from '../src/components/screens/StorageUsageScreen';

// The app shell mounts MembershipGoneGate, which calls useRouter; jsdom has no Next app-router
// context, so the router is stubbed for the mount.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

/** USAGE-001 slice 5b — the storage/billing screen. */
function mount(body: unknown, status = 200) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <StorageUsageScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
    </QueryClientProvider>,
  );
}
const G = 1024 ** 3;

describe('StorageUsageScreen', () => {
  it('renders the three figures, the (used + reserved) / quota bar, and the "not checked yet" line', async () => {
    mount({ used: 3 * G, reserved: G, quota: 8 * G, unit: 'bytes', reconciledAt: null });
    expect(await screen.findByText('3 GB')).toBeTruthy();
    expect(screen.getByText('1 GB')).toBeTruthy();
    expect(screen.getByText('8 GB')).toBeTruthy();
    expect(screen.getByText(/haven't checked this total against your files/i)).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe(String(4 * G));
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(8 * G));
    expect(bar.getAttribute('aria-valuetext')).toContain('4 GB');
  });
  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});
