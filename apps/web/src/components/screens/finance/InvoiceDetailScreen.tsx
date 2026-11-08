'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import { InvoicePaymentCard, InvoicePrintLink, InvoiceSendCard } from './InvoiceActions';
import { getClientInvoice } from './InvoiceApi';
import { invoiceMayTakePayment } from './InvoiceFormRules';
import { invoiceCapsule, invoiceStateKey } from './InvoiceRules';
import { InvoiceStateWord, useClientNames } from './InvoiceStateWord';
import '../../../styles/screens/finance-ledger.css';

export interface InvoiceDetailScreenProps {
  organizationSlug: string;
  organizationName: string;
  invoiceId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Invoice** — one client invoice (A10b): the lines, the totals, the payments and the credit notes.
 * Reads `GET …/client-invoices/:invoiceId` on `finance.view`; the line description is shown in the
 * reader's language when the invoice carries it, else the other one. A draft offers Edit and Send,
 * a sent or part-paid invoice Record payment (R35 L6-52-09; all `finance.manage` on the API).
 */
export function InvoiceDetailScreen({
  organizationSlug,
  organizationName,
  invoiceId,
  client,
}: InvoiceDetailScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();
  const clientNames = useClientNames(api, organizationSlug);

  const invoice = useQuery({
    queryKey: ['client-invoice', organizationSlug, invoiceId],
    queryFn: () => getClientInvoice(api, organizationSlug, invoiceId),
  });
  const data = invoice.data;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('InvoiceList.title', 'Invoices')}
      title={data?.number ?? tOr('InvoiceDetail.titleFallback', 'Invoice')}
      titleMeta={data ? (clientNames.get(data.clientOrganizationId) ?? undefined) : undefined}
      actions={
        <div className="tm-row">
          <Link className="tm-chip" href={`/${organizationSlug}/finance/invoices`}>
            {tOr('InvoiceDetail.back', 'All invoices')}
          </Link>
          {data?.state === 'draft' ? (
            <Link
              className="tm-button tm-button--ink"
              href={`/${organizationSlug}/finance/invoices/${encodeURIComponent(invoiceId)}/edit`}
            >
              {tOr('InvoiceDetail.editDraft', 'Edit draft')}
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="invoices" />

        {invoice.isPending ? (
          <LoadingRegion
            label={tOr('InvoiceDetail.loading', 'Loading the invoice')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {invoice.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('InvoiceDetail.errorTitle', 'The invoice could not load')}
            live
          >
            {describe(invoice.error)}
          </InlineAlert>
        ) : null}

        {data ? (
          <div className="tm-fin">
            <div className="tm-stack">
              <div className="tm-fin-table-card">
                <table className="tm-table">
                  <caption className="tm-visually-hidden">
                    {tOr('InvoiceDetail.linesCaption', 'Invoice lines')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{tOr('InvoiceDetail.colDescription', 'Description')}</th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('InvoiceDetail.colQuantity', 'Quantity')}
                      </th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('InvoiceDetail.colUnitPrice', 'Unit price')}
                      </th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('InvoiceDetail.colTax', 'Tax')}
                      </th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('InvoiceDetail.colTotal', 'Total')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          {(locale.startsWith('ar')
                            ? (line.descriptionAr ?? line.descriptionEn)
                            : (line.descriptionEn ?? line.descriptionAr)) ?? '—'}
                        </td>
                        <td className="tm-mono tm-fin-num">{line.quantity}</td>
                        <td className="tm-mono tm-fin-num">
                          {money(line.unitPriceMinor, data.currency)}
                        </td>
                        <td className="tm-mono tm-fin-num">{line.taxBp / 100}%</td>
                        <td className="tm-mono tm-fin-num">
                          {money(line.lineGrossMinor, data.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.lines.length === 0 ? (
                <InlineAlert tone="neutral">
                  {tOr('InvoiceDetail.noLines', 'This invoice has no lines yet.')}
                </InlineAlert>
              ) : null}

              {data.payments.length > 0 ? (
                <section className="tm-card" aria-labelledby="tm-fin-payments-heading">
                  <h2 id="tm-fin-payments-heading" className="tm-fin-card-title">
                    {tOr('InvoiceDetail.paymentsTitle', 'Payments')}
                  </h2>
                  <dl className="tm-fin-buckets">
                    {data.payments.map((payment) => (
                      <div key={payment.id}>
                        <dt>
                          {day(payment.paidOn)}
                          {payment.reference ? ` · ${payment.reference}` : ''}
                        </dt>
                        <dd>{money(payment.amountMinor, data.currency)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {data.creditNotes.length > 0 ? (
                <section className="tm-card" aria-labelledby="tm-fin-credit-heading">
                  <h2 id="tm-fin-credit-heading" className="tm-fin-card-title">
                    {tOr('InvoiceDetail.creditNotesTitle', 'Credit notes')}
                  </h2>
                  <dl className="tm-fin-buckets">
                    {data.creditNotes.map((note) => (
                      <div key={note.id}>
                        <dt>
                          <span className="tm-mono">{note.number}</span> · {note.reason}
                        </dt>
                        <dd>{money(note.totalMinor, data.currency)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
            </div>

            <div className="tm-fin-col">
              <section className="tm-card" aria-labelledby="tm-fin-summary-heading">
                <div className="tm-row tm-row--between">
                  <h2 id="tm-fin-summary-heading" className="tm-fin-card-title">
                    {tOr('InvoiceDetail.summaryTitle', 'Summary')}
                  </h2>
                  <StateCapsule state={invoiceCapsule(data.state, data.overdue)}>
                    <InvoiceStateWord stateKey={invoiceStateKey(data.state, data.overdue)} />
                  </StateCapsule>
                </div>
                <dl className="tm-detail-list">
                  <div className="tm-detail-list__pair">
                    <dt>{tOr('InvoiceList.colIssued', 'Issued')}</dt>
                    <dd>{data.issueDate ? day(data.issueDate) : '—'}</dd>
                  </div>
                  <div className="tm-detail-list__pair">
                    <dt>{tOr('InvoiceList.colDue', 'Due')}</dt>
                    <dd>{data.dueDate ? day(data.dueDate) : '—'}</dd>
                  </div>
                  {data.periodStart && data.periodEnd ? (
                    <div className="tm-detail-list__pair">
                      <dt>{tOr('InvoiceDetail.period', 'Period')}</dt>
                      <dd>
                        {day(data.periodStart)} – {day(data.periodEnd)}
                      </dd>
                    </div>
                  ) : null}
                  {data.poNumber ? (
                    <div className="tm-detail-list__pair">
                      <dt>{tOr('InvoiceDetail.poNumber', 'PO number')}</dt>
                      <dd className="tm-mono">{data.poNumber}</dd>
                    </div>
                  ) : null}
                  {data.sentTo ? (
                    <div className="tm-detail-list__pair">
                      <dt>{tOr('InvoiceDetail.sentTo', 'Sent to')}</dt>
                      <dd>{data.sentTo}</dd>
                    </div>
                  ) : null}
                </dl>
                <dl className="tm-fin-totals">
                  <div>
                    <dt>{tOr('InvoiceDetail.subtotal', 'Subtotal')}</dt>
                    <dd>{money(data.subtotalMinor, data.currency)}</dd>
                  </div>
                  {data.discountMinor > 0 ? (
                    <div>
                      <dt>{tOr('InvoiceDetail.discount', 'Discount')}</dt>
                      <dd>{money(data.discountMinor, data.currency)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{tOr('InvoiceDetail.tax', 'Tax')}</dt>
                    <dd>{money(data.taxMinor, data.currency)}</dd>
                  </div>
                  <div>
                    <dt>{tOr('InvoiceDetail.total', 'Total')}</dt>
                    <dd>{money(data.totalMinor, data.currency)}</dd>
                  </div>
                  <div>
                    <dt>{tOr('InvoiceDetail.paid', 'Paid')}</dt>
                    <dd>{money(data.paidMinor, data.currency)}</dd>
                  </div>
                  <div>
                    <dt>{tOr('InvoiceList.colAmountDue', 'Amount due')}</dt>
                    <dd>{money(data.amountDueMinor, data.currency)}</dd>
                  </div>
                </dl>
              </section>
              {data.state === 'draft' ? (
                <InvoiceSendCard api={api} organizationSlug={organizationSlug} invoice={data} />
              ) : (
                <InvoicePrintLink organizationSlug={organizationSlug} invoice={data} />
              )}
              {invoiceMayTakePayment(data.state) ? (
                <InvoicePaymentCard api={api} organizationSlug={organizationSlug} invoice={data} />
              ) : null}
              {data.voidReason ? (
                <InlineAlert tone="warning" title={tOr('InvoiceDetail.voidTitle', 'Voided')}>
                  {data.voidReason}
                </InlineAlert>
              ) : null}
              {data.notes ? (
                <section className="tm-card" aria-labelledby="tm-fin-notes-heading">
                  <h2 id="tm-fin-notes-heading" className="tm-fin-card-title">
                    {tOr('InvoiceDetail.notes', 'Notes')}
                  </h2>
                  <p className="tm-fin-muted">{data.notes}</p>
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
