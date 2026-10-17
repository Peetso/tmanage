'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getInvoice, listInvoices, MAX_INVOICES_PAGE } from '../../lib/api/invoices';
import type { InvoiceStatus, InvoiceSummary } from '../../lib/api/invoices';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';

export interface BillingInvoicesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Invoices** — the billing invoice history (FEAT module 19, x179). Reads
 * `GET /v1/organizations/:orgSlug/billing/invoices`, gated on `org.manage`, and opens one invoice's
 * detail with `GET …/billing/invoices/:invoiceId`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** Both reads sit behind `org.manage`; a member without it gets the
 *    ordinary 403, which `describe()` turns into a line rather than a blank page. The screen never
 *    guesses a capability of its own.
 * 2. **Read-only.** There is no invoice mutation surface this slice — the list and the detail drawer
 *    are all there is. Generating invoices from a payment provider is Needs-Peter.
 * 3. **Money is integer cents.** Amounts arrive as integer cents and are formatted for display with
 *    `Intl.NumberFormat` through the active-locale formatters; the screen never does float
 *    arithmetic on them.
 */
export function BillingInvoicesScreen({
  organizationSlug,
  organizationName,
  client,
}: BillingInvoicesScreenProps) {
  const api = client ?? browserApiClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { money, day } = useDisplayFormatters();

  const invoices = useQuery({
    queryKey: ['billing-invoices', organizationSlug],
    queryFn: () => listInvoices(api, organizationSlug, { limit: MAX_INVOICES_PAGE }),
  });

  const detail = useQuery({
    queryKey: ['billing-invoice', organizationSlug, selectedId],
    queryFn: () => getInvoice(api, organizationSlug, selectedId as string),
    enabled: selectedId !== null,
  });

  const rows = invoices.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Invoices"
      description="Your organization's billing history, newest first."
    >
      {invoices.isPending ? (
        <LoadingRegion label="Loading invoices." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {invoices.isError ? (
        <InlineAlert tone="danger" title="Could not load invoices" live>
          {describe(invoices.error)}
        </InlineAlert>
      ) : null}

      {!invoices.isPending && !invoices.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral">No invoices yet.</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-invoices-heading">
          <h2 id="tm-invoices-heading" className="tm-eyebrow">
            Invoices
          </h2>
          <table className="tm-table" aria-label="Invoices, newest first">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Period</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col">
                  <span className="tm-visually-hidden">Detail</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="tm-mono">{invoice.number}</td>
                  <td>
                    {day(invoice.periodStart)} – {day(invoice.periodEnd)}
                  </td>
                  <td className="tm-mono">{money(invoice.amountCents, invoice.currency)}</td>
                  <td>
                    <StatusDot tone={statusTone(invoice.status)}>{invoice.status}</StatusDot>
                  </td>
                  <td className="tm-mono">{day(invoice.issuedAt)}</td>
                  <td>
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      onClick={() => setSelectedId(invoice.id)}
                      aria-label={`View invoice ${invoice.number}`}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {selectedId !== null ? (
        <aside
          className="tm-panel tm-stack"
          role="region"
          aria-labelledby="tm-invoice-detail-heading"
        >
          <div className="tm-row tm-row--wrap">
            <h2 id="tm-invoice-detail-heading" className="tm-eyebrow">
              Invoice detail
            </h2>
            <Button type="button" tone="text" size="compact" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          </div>

          {detail.isPending ? (
            <LoadingRegion label="Loading invoice detail." className="tm-stack tm-stack--tight">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {detail.isError ? (
            <InlineAlert tone="danger" title="Could not load this invoice" live>
              {describe(detail.error)}
            </InlineAlert>
          ) : null}

          {detail.data ? (
            <>
              <dl className="tm-definition">
                <div>
                  <dt>Number</dt>
                  <dd className="tm-mono">{detail.data.number}</dd>
                </div>
                <div>
                  <dt>Period</dt>
                  <dd>
                    {day(detail.data.periodStart)} – {day(detail.data.periodEnd)}
                  </dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd className="tm-mono">
                    {money(detail.data.amountCents, detail.data.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <StatusDot tone={statusTone(detail.data.status)}>
                      {detail.data.status}
                    </StatusDot>
                  </dd>
                </div>
                <div>
                  <dt>Issued</dt>
                  <dd className="tm-mono">{day(detail.data.issuedAt)}</dd>
                </div>
              </dl>

              {detail.data.lineItems.length > 0 ? (
                <table className="tm-table" aria-label="Line items">
                  <thead>
                    <tr>
                      <th scope="col">Description</th>
                      <th scope="col">Qty</th>
                      <th scope="col">Unit</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.lineItems.map((item, index) => (
                      <tr key={`${item.description}-${index}`}>
                        <td>{item.description}</td>
                        <td className="tm-mono">{item.quantity}</td>
                        <td className="tm-mono">
                          {money(item.unitAmountCents, detail.data.currency)}
                        </td>
                        <td className="tm-mono">{money(item.amountCents, detail.data.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <InlineAlert tone="neutral">This invoice has no line-item breakdown.</InlineAlert>
              )}
            </>
          ) : null}
        </aside>
      ) : null}
    </AppShell>
  );
}

/** Map an invoice status to a status-dot tone. */
function statusTone(status: InvoiceStatus): StatusTone {
  if (status === 'paid') return 'success';
  if (status === 'void') return 'neutral';
  return 'warning';
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

export type { InvoiceSummary };
