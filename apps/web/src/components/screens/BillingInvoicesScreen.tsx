'use client';

import { useState } from 'react';
import Link from 'next/link';
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
import '../../styles/screens/billing.css';

export interface BillingInvoicesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Invoices** — the billing invoice history (FEAT module 19, x179), drawn as BIL-02: the count as
 * the headline, the history as a table card on the left (an open invoice ruled red at the start),
 * and the cards on the right — the unpaid invoice, the selected invoice's detail and "who can see
 * this". Reads `GET /v1/organizations/:orgSlug/billing/invoices`, gated on `org.manage`, and opens
 * one invoice's detail with `GET …/billing/invoices/:invoiceId`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** Both reads sit behind `org.manage`; a member without it gets the
 *    ordinary 403, which `describe()` turns into a line rather than a blank page. The screen never
 *    guesses a capability of its own.
 * 2. **Read-only.** There is no invoice mutation surface this slice — no retry, no download — so
 *    the design's "Retry now" and "Download all as ZIP" capsules are not drawn.
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
  const open = rows.find((invoice) => invoice.status === 'open') ?? null;
  const currencies = [...new Set(rows.map((invoice) => invoice.currency.toUpperCase()))];
  const earliest = rows.reduce<string | null>(
    (first, invoice) => (first === null || invoice.issuedAt < first ? invoice.issuedAt : first),
    null,
  );
  const meta =
    rows.length > 0
      ? [
          earliest ? `since ${day(earliest, { month: 'short', year: 'numeric' })}` : null,
          currencies.length === 1 ? `all in ${currencies[0]}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Billing · Invoices"
      title={
        rows.length > 0
          ? `${rows.length} ${rows.length === 1 ? 'invoice' : 'invoices'}`
          : 'Invoices'
      }
      titleMeta={meta}
      description={
        rows.length > 0 ? undefined : "Your organization's billing history, newest first."
      }
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
        <div className="tm-bil">
          <section className="tm-bil-main" aria-labelledby="tm-invoices-heading">
            <h2 id="tm-invoices-heading" className="tm-visually-hidden">
              Invoices
            </h2>
            <div className="tm-bil-table-card">
              <table className="tm-table" aria-label="Invoices, newest first">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">What for</th>
                    <th scope="col">Number</th>
                    <th scope="col" className="tm-bil-num">
                      Amount
                    </th>
                    <th scope="col" className="tm-bil-num">
                      Status
                    </th>
                    <th scope="col">
                      <span className="tm-visually-hidden">Detail</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((invoice) => (
                    <tr
                      key={invoice.id}
                      className={[
                        invoice.status === 'open' ? 'tm-bil-row--open' : '',
                        invoice.status === 'void' ? 'tm-bil-row--void' : '',
                        invoice.id === selectedId ? 'tm-bil-row--selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <td className="tm-mono tm-bil-date">{day(invoice.issuedAt)}</td>
                      <td>
                        <span className="tm-bil-cell-title">
                          {day(invoice.periodStart)} – {day(invoice.periodEnd)}
                        </span>
                        <span className="tm-bil-cell-sub">{statusLine(invoice.status)}</span>
                      </td>
                      <td className="tm-mono">{invoice.number}</td>
                      <td className="tm-bil-num tm-bil-amount">
                        {money(invoice.amountCents, invoice.currency)}
                      </td>
                      <td className="tm-bil-num">
                        <span
                          className={`tm-bil-status tm-bil-status--${invoice.status === 'open' ? 'danger' : statusTone(invoice.status)}`}
                        >
                          {statusLabel(invoice.status)}
                        </span>
                      </td>
                      <td className="tm-bil-num">
                        <Button
                          type="button"
                          tone="text"
                          size="compact"
                          onClick={() => setSelectedId(invoice.id)}
                          aria-label={`View invoice ${invoice.number}`}
                          aria-pressed={invoice.id === selectedId}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="tm-bil-col">
            {open ? (
              <section
                className="tm-bil-card tm-bil-card--danger"
                aria-labelledby="tm-invoice-open-heading"
              >
                <h2 id="tm-invoice-open-heading" className="tm-bil-eyebrow tm-bil-eyebrow--danger">
                  Payment not received yet
                </h2>
                <p className="tm-bil-card__lead">
                  {money(open.amountCents, open.currency)} on {open.number} is still open
                </p>
                <p className="tm-bil-card__body">
                  Issued {day(open.issuedAt)} for {day(open.periodStart)} – {day(open.periodEnd)}.
                  It stays open until the payment is recorded.
                </p>
                <div className="tm-bil-actions">
                  <Button type="button" tone="ink" onClick={() => setSelectedId(open.id)}>
                    Open the invoice
                  </Button>
                </div>
              </section>
            ) : null}

            {selectedId !== null ? (
              <aside
                className="tm-bil-card"
                role="region"
                aria-labelledby="tm-invoice-detail-heading"
              >
                <div className="tm-row tm-row--between">
                  <h2 id="tm-invoice-detail-heading" className="tm-bil-card__title">
                    Invoice detail
                  </h2>
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    onClick={() => setSelectedId(null)}
                  >
                    Close
                  </Button>
                </div>

                {detail.isPending ? (
                  <LoadingRegion
                    label="Loading invoice detail."
                    className="tm-stack tm-stack--tight"
                  >
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
                      <div className="tm-bil-table-card">
                        <table className="tm-table" aria-label="Line items">
                          <thead>
                            <tr>
                              <th scope="col">Description</th>
                              <th scope="col" className="tm-bil-num">
                                Qty
                              </th>
                              <th scope="col" className="tm-bil-num">
                                Unit
                              </th>
                              <th scope="col" className="tm-bil-num">
                                Amount
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.data.lineItems.map((item, index) => (
                              <tr key={`${item.description}-${index}`}>
                                <td>{item.description}</td>
                                <td className="tm-mono tm-bil-num">{item.quantity}</td>
                                <td className="tm-mono tm-bil-num">
                                  {money(item.unitAmountCents, detail.data.currency)}
                                </td>
                                <td className="tm-mono tm-bil-num">
                                  {money(item.amountCents, detail.data.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <InlineAlert tone="neutral">
                        This invoice has no line-item breakdown.
                      </InlineAlert>
                    )}

                    <Link
                      href={`/${organizationSlug}/billing/invoices/${encodeURIComponent(detail.data.id)}/lines`}
                      className="tm-bil-capsule"
                    >
                      All line items
                    </Link>
                  </>
                ) : null}
              </aside>
            ) : null}

            <section
              className="tm-bil-card tm-bil-card--paper tm-bil-card--fill"
              aria-labelledby="tm-invoice-audience-heading"
            >
              <h2 id="tm-invoice-audience-heading" className="tm-bil-eyebrow">
                Who can see this
              </h2>
              <p className="tm-bil-card__body">
                Only owners. Project managers and members never see amounts or invoices.
              </p>
              <p className="tm-bil-card__foot">
                Amounts are shown in the invoice&rsquo;s currency.
              </p>
            </section>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

/** The quiet line under the period: what this status means for the person paying. */
function statusLine(status: InvoiceStatus): string {
  if (status === 'paid') return 'paid';
  if (status === 'void') return 'void · not charged';
  return 'open · awaiting payment';
}

/** The capsule label: "Paid", "Open", "Void". */
function statusLabel(status: InvoiceStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
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
