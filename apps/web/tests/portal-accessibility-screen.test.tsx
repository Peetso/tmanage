import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PortalAccessibilityScreen } from '../src/components/screens/PortalAccessibilityScreen';
import { ApiClient } from '../src/lib/api/client';

vi.mock('../src/components/shell/ThemeSync', () => ({ ThemeSync: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '' }));

/**
 * PORTALA11Y: the member app's accessibility form renders inside the client portal and reads and
 * saves the client's own settings through the portal route (never the member `/me/accessibility`).
 */
describe('PortalAccessibilityScreen (PORTALA11Y)', () => {
  it('renders the shared form in the portal and saves to the portal route', async () => {
    const calls: { url: string; method: string }[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        const body = init?.body ?? '{"fontScale":"md","reduceMotion":false,"highContrast":false}';
        return Promise.resolve(new Response(String(body), { status: 200 }));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf-token',
      newCorrelationId: () => 'correlation-fixed',
    });
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queries}>
        <PortalAccessibilityScreen
          organizationSlug="northwind"
          clientName="Acme"
          providerName="Northwind"
          client={client}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'Display and accessibility' }),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('radio', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const own = calls.filter((call) => call.url.includes('/accessibility'));
    expect(own.every((call) => call.url.includes('/organizations/northwind/portal/me/'))).toBe(
      true,
    );
  });
});
