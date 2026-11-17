import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalInvoiceScreen } from '../src/components/screens/portal-money/PortalInvoiceScreen';
import { PortalMoneyScreen } from '../src/components/screens/portal-money/PortalMoneyScreen';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/northstar/portal/money',
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => (cleanup(), push.mockReset(), act(() => activeLocale.set('en-US'))));

/**
 * 52-13 — the client portal Money screens. What the API enforces (own client only, 404 for
 * anyone else's invoice, no internal figures) is proved in portal-invoices.controller.test.ts;
 * this proves what the screens do with what they are given.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function api(routes: Record<string, () => Response>): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      const hit = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((path) => url.includes(path));
      return Promise.resolve(hit ? routes[hit]!() : json({ projects: [] }));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-142',
    number: 'INV-2026-0142',
    kind: 'standard',
    language: 'en',
    state: 'sent',
    documentLabel: 'tax_invoice',
    documentLabelText: 'Tax invoice',
    taxNotice: null,
    taxRegistrationRef: null,
    issueDate: '2026-10-30',
    dueDate: '2026-11-13',
    currency: 'EGP',
    subtotalMinor: 4_000_000,
    discountMinor: 0,
    taxMinor: 560_000,
    totalMinor: 4_560_000,
    paidMinor: 0,
    amountDueMinor: 4_560_000,
    standing: { kind: 'overdue', days: 3 },
    ...overrides,
  };
}

const PAID = invoice({
  id: 'inv-128',
  number: 'INV-2026-0128',
  issueDate: '2026-10-02',
  paidMinor: 4_560_000,
  amountDueMinor: 0,
  standing: { kind: 'paid' },
});
const RETAINER = {
  id: 'ret-1',
  name: 'Monthly support',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  allowanceHours: 20,
  usedHours: 14.5,
  remainingHours: 5.5,
  renewsOn: '2026-12-01',
};
const PROJECT = {
  id: 'proj-1',
  name: 'Website relaunch',
  status: 'active',
  committedAt: null,
  forecastAt: null,
};

function renderMoney(
  invoices: readonly unknown[],
  budget: () => Response = () => json({ percentUsed: 64, status: 'on_track' }),
) {
  return render(
    withQuery(
      <PortalMoneyScreen
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        providerName="Northstar Design"
        client={api({
          '/portal/invoices': () => json({ invoices }),
          '/portal/retainers': () => json({ retainers: [RETAINER] }),
          '/portal/projects/proj-1/budget': budget,
          '/portal/projects': () => json({ projects: [PROJECT] }),
        })}
      />,
    ),
  );
}

describe('52-13 portal Money overview', () => {
  it('lists the invoices with where each stands, and a row opens the invoice', async () => {
    renderMoney([invoice(), PAID]);
    const table = await screen.findByRole('table');
    const link = within(table).getByRole('link', { name: 'INV-2026-0142' });
    expect(link.getAttribute('href')).toBe('/northstar/portal/money/inv-142');
    expect(within(table).getByText('Overdue · 3 days')).toBeTruthy();
    expect(within(table).getByText('Paid')).toBeTruthy();
    // The download is its own target, named with the invoice number, on the portal print route.
    const download = within(table).getByRole('link', { name: 'Download PDF of INV-2026-0142' });
    expect(download.getAttribute('href')).toContain('/portal/invoices/inv-142/pdf?lang=en');
    // Clicking anywhere else on the row opens the invoice.
    fireEvent.click(within(table).getByText('Overdue · 3 days'));
    expect(push).toHaveBeenCalledWith('/northstar/portal/money/inv-142');
    expect(
      screen.getByText(
        /You have 1 invoice to pay, EGP\s45,600 in total\. One is past its due date\./u,
      ),
    ).toBeTruthy();
  });

  it('shows the calm empty state when nothing is left to pay', async () => {
    renderMoney([PAID]);
    expect(await screen.findByText('Nothing to pay right now')).toBeTruthy();
    expect(screen.getByText(/Every invoice from Northstar Design is paid\./u)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the retainer and the budget use, and only the fields the API sent', async () => {
    renderMoney([invoice()]);
    expect(await screen.findByText('Monthly support')).toBeTruthy();
    expect(screen.getByText('of 20 hours used')).toBeTruthy();
    expect(
      screen.getByText(/About three quarters of this period's hours are used\./u),
    ).toBeTruthy();
    expect(await screen.findByText('Website relaunch')).toBeTruthy();
    expect(screen.getByText('On track')).toBeTruthy();
    // No remainingHours in the budget view: the sentence names no hours.
    expect(screen.getByText('Work is on track.')).toBeTruthy();
    expect(screen.queryByText(/paid this year/iu)).toBeNull();
    const bars = screen.getAllByRole('progressbar');
    expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['73', '64']);
  });

  it('leaves the budget card out when the project budget is not shared (404)', async () => {
    renderMoney([invoice()], () =>
      json({ error: { code: 'not_found', message: 'Not found' } }, 404),
    );
    expect(await screen.findByText('Monthly support')).toBeTruthy();
    expect(screen.queryByText('Project budget')).toBeNull();
  });
});

describe('52-13 portal invoice', () => {
  function renderInvoice(body: Record<string, unknown>) {
    return render(
      withQuery(
        <PortalInvoiceScreen
          organizationSlug="northstar"
          invoiceId="inv-142"
          clientName="Atlas Hospitality"
          providerName="Northstar Design"
          client={api({ '/portal/invoices/inv-142': () => json(body) })}
        />,
      ),
    );
  }

  it('shows lines, totals and Download PDF; hides the tax registration and note it lacks', async () => {
    renderInvoice({
      ...invoice(),
      notes: null,
      lines: [
        {
          description: 'Homepage design and build',
          quantity: 1,
          unit: 'project',
          unitPriceMinor: 2_400_000,
          taxBp: 1400,
          netMinor: 2_400_000,
          grossMinor: 2_736_000,
        },
      ],
      payments: [],
    });
    expect(await screen.findByText('Homepage design and build')).toBeTruthy();
    expect(screen.getByText('Tax (14%)')).toBeTruthy();
    expect(screen.getByText('No payments yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download PDF/u }).getAttribute('href')).toContain(
      '/portal/invoices/inv-142/pdf',
    );
    expect(screen.queryByText(/tax registration/iu)).toBeNull();
    expect(screen.queryByText(/Note from/u)).toBeNull();
  });

  it("labels the tax number as the agency's and shows its note when sent", async () => {
    renderInvoice({
      ...invoice({ taxRegistrationRef: '512-334-871' }),
      notes: 'Quote the number.',
      lines: [],
      payments: [],
    });
    expect(await screen.findByText('Northstar Design tax registration')).toBeTruthy();
    expect(screen.getByText('Note from Northstar Design')).toBeTruthy();
  });

  it('says calmly that an invoice that is not the client’s is not available', async () => {
    render(
      withQuery(
        <PortalInvoiceScreen
          organizationSlug="northstar"
          invoiceId="other"
          clientName="Atlas Hospitality"
          providerName="Northstar Design"
          client={api({
            '/portal/invoices/other': () =>
              json({ error: { code: 'not_found', message: 'Not found' } }, 404),
          })}
        />,
      ),
    );
    expect(await screen.findByText(/This invoice is not available\./u)).toBeTruthy();
  });
});
