import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InvoiceListScreen } from '../src/components/screens/finance/InvoiceListScreen';
import { ApiClient } from '../src/lib/api/client';

/**
 * D6 — the client page's Invoices tab opens the invoice list narrowed to that company: the list
 * asks the API for that client only (the API keeps its own `finance.view` gate) and says so.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(clientOrganizationId?: string) {
  const asked: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.includes('/client-invoices/aging')) return Promise.resolve(json({ buckets: [] }));
      if (url.includes('/client-invoices')) {
        return Promise.resolve(json({ invoices: [], nextCursor: null }));
      }
      if (url.includes('/client-organizations')) {
        return Promise.resolve(
          json({ clientOrganizations: [{ id: 'co-1', name: 'Cedar Foods' }], nextCursor: null }),
        );
      }
      return Promise.resolve(json({}));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InvoiceListScreen
        organizationSlug="acme"
        organizationName="Acme"
        client={client}
        {...(clientOrganizationId === undefined ? {} : { clientOrganizationId })}
      />
    </QueryClientProvider>,
  );
  return asked;
}

const listReads = (asked: readonly string[]) =>
  asked.filter((url) => /\/client-invoices(\?|$)/.test(url));

describe('Invoice list narrowed to one client (D6)', () => {
  it('asks for that client only and says so, with the way back to all', async () => {
    const asked = mount('co-1');
    await waitFor(() => expect(listReads(asked)).toHaveLength(1));
    expect(listReads(asked)[0]).toContain('clientOrganizationId=co-1');
    expect((await screen.findByText('Cedar Foods')).tagName).toBe('BDI');
    expect(screen.getByRole('link', { name: 'Show all' }).getAttribute('href')).toBe(
      '/acme/finance/invoices',
    );
  });

  it('without `?client=` it reads every invoice and draws no filter line', async () => {
    const asked = mount();
    await waitFor(() => expect(listReads(asked)).toHaveLength(1));
    expect(listReads(asked)[0]).not.toContain('clientOrganizationId');
    expect(screen.queryByRole('link', { name: 'Show all' })).toBeNull();
  });
});
