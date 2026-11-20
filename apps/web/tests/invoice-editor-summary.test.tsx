import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InvoiceEditorScreen } from '../src/components/screens/finance/InvoiceEditorScreen';
import { ApiClient } from '../src/lib/api/client';

vi.mock('next/navigation', () => ({
  usePathname: () => '/northstar/finance/invoices/new',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

/**
 * QA-FIX-R L14 — a refused invoice line (a tax rate of 250 %) is named beside "Save draft", not
 * only at the field far up the page, and nothing is sent.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Invoice editor: why a draft was not saved', () => {
  it('names the refused line next to Save draft and sends nothing', async () => {
    const writes: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if ((init?.method ?? 'GET') !== 'GET') writes.push(url.pathname);
        if (url.pathname.endsWith('/client-organizations')) {
          return Promise.resolve(
            json({
              clientOrganizations: [{ id: 'co-1', name: 'Atlas Co', archivedAt: null }],
            }),
          );
        }
        return Promise.resolve(json({ error: { code: 'not_found', message: 'Not found' } }, 404));
      }) as typeof globalThis.fetch,
      readCsrfToken: () => 'csrf',
      newCorrelationId: () => 'c',
    });
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <InvoiceEditorScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          invoiceId={null}
          client={client}
        />
      </QueryClientProvider>,
    );

    await screen.findByRole('option', { name: 'Atlas Co' });
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Design' } });
    fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/^Unit price/), { target: { value: '450' } });
    fireEvent.change(screen.getByLabelText(/^Tax %/), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Line 1: Enter a tax rate from 0 to 100.')).toBeInTheDocument();
    expect(writes).toEqual([]);
  });
});
