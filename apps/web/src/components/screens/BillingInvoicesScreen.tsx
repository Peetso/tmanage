'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getInvoice, listInvoices, MAX_INVOICES_PAGE } from '../../lib/api/invoices';
import type { InvoiceStatus, InvoiceSummary } from '../../lib/api/invoices';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
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
  const t = useT();

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
          earliest
            ? `${t('BillingInvoicesScreen.since')} ${day(earliest, { month: 'short', year: 'numeric' })}`
            : null,
          currencies.length === 1 ? `${t('BillingInvoicesScreen.allIn')} ${currencies[0]}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined;

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('BillingInvoicesScreen.eyebrow')}
      title={
        rows.length > 0
          ? `${rows.length} ${rows.length === 1 ? t('BillingInvoicesScreen.invoiceOne') : t('BillingInvoicesScreen.invoiceMany')}`
          : t('BillingInvoicesScreen.titleFallback')
      }
      titleMeta={meta}
      description={rows.length > 0 ? undefined : t('BillingInvoicesScreen.description')}
    >
      {invoices.isPending ? (
        <LoadingRegion
          label={t('BillingInvoicesScreen.loadingInvoices')}
          className="tm-stack tm-stack--tight"
        >
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {invoices.isError ? (
        <InlineAlert tone="danger" title={t('BillingInvoicesScreen.errorLoadTitle')} live>
          {describe(t, invoices.error)}
        </InlineAlert>
      ) : null}

      {!invoices.isPending && !invoices.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral">{t('BillingInvoicesScreen.noInvoices')}</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div className="tm-bil">
          <section className="tm-bil-main" aria-labelledby="tm-invoices-heading">
            <h2 id="tm-invoices-heading" className="tm-visually-hidden">
              {t('BillingInvoicesScreen.invoicesHeading')}
            </h2>
            <div className="tm-bil-table-card">
              <table className="tm-table" aria-label={t('BillingInvoicesScreen.tableLabel')}>
                <thead>
                  <tr>
                    <th scope="col">{t('BillingInvoicesScreen.colDate')}</th>
                    <th scope="col">{t('BillingInvoicesScreen.colWhatFor')}</th>
                    <th scope="col">{t('BillingInvoicesScreen.number')}</th>
                    <th scope="col" className="tm-bil-num">
                      {t('BillingInvoicesScreen.amount')}
                    </th>
                    <th scope="col" className="tm-bil-num">
                      {t('BillingInvoicesScreen.status')}
                    </th>
                    <th scope="col">
                      <span className="tm-visually-hidden">
                        {t('BillingInvoicesScreen.colDetail')}
                      </span>
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
                        <span className="tm-bil-cell-sub">{statusLine(t, invoice.status)}</span>
                      </td>
                      <td className="tm-mono">{invoice.number}</td>
                      <td className="tm-bil-num tm-bil-amount">
                        {money(invoice.amountCents, invoice.currency)}
                      </td>
                      <td className="tm-bil-num">
                        <span
                          className={`tm-bil-status tm-bil-status--${invoice.status === 'open' ? 'danger' : statusTone(invoice.status)}`}
                        >
                          {statusLabel(t, invoice.status)}
                        </span>
                      </td>
                      <td className="tm-bil-num">
                        <Button
                          type="button"
                          tone="text"
                          size="compact"
                          onClick={() => setSelectedId(invoice.id)}
                          aria-label={`${t('BillingInvoicesScreen.viewInvoice')} ${invoice.number}`}
                          aria-pressed={invoice.id === selectedId}
                        >
                          {t('BillingInvoicesScreen.view')}
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
                  {t('BillingInvoicesScreen.paymentNotReceived')}
                </h2>
                <p className="tm-bil-card__lead">
                  {money(open.amountCents, open.currency)} {t('BillingInvoicesScreen.onWord')}{' '}
                  {open.number} {t('BillingInvoicesScreen.isStillOpen')}
                </p>
                <p className="tm-bil-card__body">
                  {t('BillingInvoicesScreen.issued')} {day(open.issuedAt)}{' '}
                  {t('BillingInvoicesScreen.forWord')} {day(open.periodStart)} –{' '}
                  {day(open.periodEnd)}. {t('BillingInvoicesScreen.staysOpen')}
                </p>
                <div className="tm-bil-actions">
                  <Button type="button" tone="ink" onClick={() => setSelectedId(open.id)}>
                    {t('BillingInvoicesScreen.openInvoice')}
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
                    {t('BillingInvoicesScreen.invoiceDetail')}
                  </h2>
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    onClick={() => setSelectedId(null)}
                  >
                    {t('BillingInvoicesScreen.close')}
                  </Button>
                </div>

                {detail.isPending ? (
                  <LoadingRegion
                    label={t('BillingInvoicesScreen.loadingDetail')}
                    className="tm-stack tm-stack--tight"
                  >
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}

                {detail.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('BillingInvoicesScreen.errorLoadDetailTitle')}
                    live
                  >
                    {describe(t, detail.error)}
                  </InlineAlert>
                ) : null}

                {detail.data ? (
                  <>
                    <dl className="tm-definition">
                      <div>
                        <dt>{t('BillingInvoicesScreen.number')}</dt>
                        <dd className="tm-mono">{detail.data.number}</dd>
                      </div>
                      <div>
                        <dt>{t('BillingInvoicesScreen.period')}</dt>
                        <dd>
                          {day(detail.data.periodStart)} – {day(detail.data.periodEnd)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('BillingInvoicesScreen.amount')}</dt>
                        <dd className="tm-mono">
                          {money(detail.data.amountCents, detail.data.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('BillingInvoicesScreen.status')}</dt>
                        <dd>
                          <StatusDot tone={statusTone(detail.data.status)}>
                            {detail.data.status}
                          </StatusDot>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('BillingInvoicesScreen.issuedLabel')}</dt>
                        <dd className="tm-mono">{day(detail.data.issuedAt)}</dd>
                      </div>
                    </dl>

                    {detail.data.lineItems.length > 0 ? (
                      <div className="tm-bil-table-card">
                        <table
                          className="tm-table"
                          aria-label={t('BillingInvoicesScreen.lineItemsLabel')}
                        >
                          <thead>
                            <tr>
                              <th scope="col">{t('BillingInvoicesScreen.colDescription')}</th>
                              <th scope="col" className="tm-bil-num">
                                {t('BillingInvoicesScreen.colQty')}
                              </th>
                              <th scope="col" className="tm-bil-num">
                                {t('BillingInvoicesScreen.colUnit')}
                              </th>
                              <th scope="col" className="tm-bil-num">
                                {t('BillingInvoicesScreen.amount')}
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
                        {t('BillingInvoicesScreen.noBreakdown')}
                      </InlineAlert>
                    )}

                    <Link
                      href={`/${organizationSlug}/billing/invoices/${encodeURIComponent(detail.data.id)}/lines`}
                      className="tm-bil-capsule"
                    >
                      {t('BillingInvoicesScreen.allLineItems')}
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
                {t('BillingInvoicesScreen.whoSees')}
              </h2>
              <p className="tm-bil-card__body">{t('BillingInvoicesScreen.whoSeesBody')}</p>
              <p className="tm-bil-card__foot">{t('BillingInvoicesScreen.currencyFoot')}</p>
            </section>
          </div>
        </div>
      ) : null}
    </SettingsShell>
  );
}

/** The quiet line under the period: what this status means for the person paying. */
function statusLine(t: ReturnType<typeof useT>, status: InvoiceStatus): string {
  if (status === 'paid') return t('BillingInvoicesScreen.statusPaid');
  if (status === 'void') return t('BillingInvoicesScreen.statusVoid');
  return t('BillingInvoicesScreen.statusOpen');
}

/** The capsule label: "Paid", "Open", "Void". */
function statusLabel(t: ReturnType<typeof useT>, status: InvoiceStatus): string {
  if (status === 'paid') return t('BillingInvoicesScreen.labelPaid');
  if (status === 'void') return t('BillingInvoicesScreen.labelVoid');
  return t('BillingInvoicesScreen.labelOpen');
}

/** Map an invoice status to a status-dot tone. */
function statusTone(status: InvoiceStatus): StatusTone {
  if (status === 'paid') return 'success';
  if (status === 'void') return 'neutral';
  return 'warning';
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('BillingInvoicesScreen.errorApiUnreachable');
  return t('BillingInvoicesScreen.errorGeneric');
}

export type { InvoiceSummary };
