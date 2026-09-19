import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { StorageUsageScreen } from '../src/components/screens/StorageUsageScreen';

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
  it('renders the three figures, the (used + reserved) / quota bar, and "never reconciled"', async () => {
    mount({ used: 3 * G, reserved: G, quota: 8 * G, unit: 'bytes', reconciledAt: null });
    expect(await screen.findByText('3 GiB')).toBeTruthy();
    expect(screen.getByText('1 GiB')).toBeTruthy();
    expect(screen.getByText('8 GiB')).toBeTruthy();
    expect(screen.getByText(/never reconciled/i)).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe(String(4 * G));
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe(String(8 * G));
    expect(bar.getAttribute('aria-valuetext')).toContain('4 GiB');
  });
  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});
