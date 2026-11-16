'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../../shell/ClientPortalShell';
import { NavIcon } from '../../icons/phone/PhoneIcon';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { getPortalInvoice, type PortalInvoice } from '../../../lib/api/portal-money';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { usePortalNames } from '../../../lib/use-organization-names';
import { longDay } from '../PortalParts';
import {
  DownloadPdfLink,
  StandingCapsule,
  describeMoneyError,
  isNotFound,
  useMoney,
  type MoneyText,
} from './PortalMoneyParts';

export interface PortalInvoiceScreenProps {
  organizationSlug: string;
  invoiceId: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/** "30 Oct 2026" — the invoice page's day with its year. */
function fullDay(
  value: string,
  locale: string,
  day: (iso: string, o: Intl.DateTimeFormatOptions) => string,
): string {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? day(`${value}T00:00:00Z`, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : longDay(value, locale);
}

/** One tax rate for every line reads "Tax (14%)"; mixed rates read "Tax". */
function taxLabel(invoice: PortalInvoice, tOr: MoneyText, percent: (bp: number) => string): string {
  const rates = new Set(invoice.lines.map((line) => line.taxBp));
  const [only] = [...rates];
  return rates.size === 1 && only !== undefined && only > 0
    ? tOr('PortalMoney.taxAt', 'Tax ({rate})').replace('{rate}', percent(only))
    : tOr('PortalMoney.tax', 'Tax');
}

/**
 * **52-13 Invoice** — one of the client's invoices, opened from Money (Figma 627:35648): what is
 * being paid for, the totals and tax, the due date and where it stands, and "Download PDF" as the
 * primary action. Only what the portal read returns: the tax registration (the agency's, labelled
 * so), the note and the payments show only when the invoice carries them.
 */
export function PortalInvoiceScreen({
  organizationSlug,
  invoiceId,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalInvoiceScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const money = useMoney();
  const { day, number } = useDisplayFormatters();
  const percent = (bp: number) => `${number(bp / 100, { maximumFractionDigits: 2 })}%`;

  const query = useQuery({
    queryKey: ['portal-invoice', organizationSlug, invoiceId],
    queryFn: () => getPortalInvoice(api, organizationSlug, invoiceId),
    retry: (failures, error) => !isNotFound(error) && failures < 2,
  });
  const invoice = query.data;
  const when = (value: string) => fullDay(value, locale, day);

  const headline = (() => {
    if (!invoice) return undefined;
    const left = money(invoice.amountDueMinor, invoice.currency);
    if (invoice.standing.kind === 'paid')
      return tOr('PortalMoney.paidInFull', 'Paid in full. Thank you.');
    if (invoice.dueDate === null)
      return tOr('PortalMoney.toPayOpen', '{amount} to pay.').replace('{amount}', left);
    const key =
      invoice.standing.kind === 'overdue' ? 'PortalMoney.toPayWasDue' : 'PortalMoney.toPayDue';
    const english =
      invoice.standing.kind === 'overdue'
        ? '{amount} to pay. It was due on {date}.'
        : '{amount} to pay, due on {date}.';
    return tOr(key, english).replace('{amount}', left).replace('{date}', when(invoice.dueDate));
  })();

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="money"
      title={invoice?.number ?? tOr('PortalMoney.invoice', 'Invoice')}
      eyebrow={
        invoice
          ? [
              invoice.documentLabelText,
              invoice.issueDate
                ? `${tOr('PortalMoney.issued', 'Issued')} ${when(invoice.issueDate)}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      description={
        invoice ? (
          <span className="tm-pm-headline">
            <StandingCapsule standing={invoice.standing} />
            <span>{headline}</span>
          </span>
        ) : undefined
      }
      headerAside={
        invoice ? (
          <DownloadPdfLink
            organizationSlug={organizationSlug}
            invoiceId={invoice.id}
            number={invoice.number}
            variant="button"
          />
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact tm-pm">
        <Link className="tm-pm-back" href={`/${organizationSlug}/portal/money`}>
          <NavIcon name="back" size={16} />
          {tOr('PortalMoney.allInvoices', 'All invoices')}
        </Link>

        {query.isPending ? (
          <LoadingRegion label={tOr('PortalMoney.loadingInvoice', 'Loading the invoice')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {query.isError ? (
          isNotFound(query.error) ? (
            <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
              {tOr(
                'PortalMoney.invoiceNotFound',
                'This invoice is not available. It may have been withdrawn.',
              )}
            </p>
          ) : (
            <InlineAlert
              tone="danger"
              title={tOr('PortalMoney.couldNotLoadInvoice', 'We could not load this invoice')}
              live
            >
              {describeMoneyError(query.error, tOr)}
            </InlineAlert>
          )
        ) : null}

        {invoice ? (
          <div className="tm-pm-invoice">
            <section className="tm-pt-col" aria-labelledby="tm-pm-lines">
              <h2 id="tm-pm-lines" className="tm-pt-section-title">
                {tOr('PortalMoney.whatYouPayFor', 'What you are paying for')}
              </h2>
              <div className="tm-pt-card tm-pm-table-card">
                <table className="tm-pm-lines">
                  <thead>
                    <tr>
                      <th scope="col">{tOr('PortalMoney.colDescription', 'Description')}</th>
                      <th scope="col">{tOr('PortalMoney.colQuantity', 'Quantity')}</th>
                      <th scope="col">{tOr('PortalMoney.colUnitPrice', 'Unit price')}</th>
                      <th scope="col">{tOr('PortalMoney.colTax', 'Tax')}</th>
                      <th scope="col">{tOr('PortalMoney.colAmount', 'Amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lines.map((line, index) => (
                      <tr key={`${index}:${line.description}`}>
                        <th scope="row">{line.description}</th>
                        <td>
                          {number(line.quantity, { maximumFractionDigits: 2 })} {line.unit}
                        </td>
                        <td>
                          <bdi>{money(line.unitPriceMinor, invoice.currency)}</bdi>
                        </td>
                        <td>{percent(line.taxBp)}</td>
                        <td className="tm-pm-strong">
                          <bdi>{money(line.netMinor, invoice.currency)}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <dl className="tm-pm-totals">
                  <div>
                    <dt>{tOr('PortalMoney.subtotal', 'Subtotal')}</dt>
                    <dd>
                      <bdi>{money(invoice.subtotalMinor, invoice.currency)}</bdi>
                    </dd>
                  </div>
                  {invoice.discountMinor > 0 ? (
                    <div>
                      <dt>{tOr('PortalMoney.discount', 'Discount')}</dt>
                      <dd>
                        <bdi>−{money(invoice.discountMinor, invoice.currency)}</bdi>
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{taxLabel(invoice, tOr, percent)}</dt>
                    <dd>
                      <bdi>{money(invoice.taxMinor, invoice.currency)}</bdi>
                    </dd>
                  </div>
                  <div className="tm-pm-totals__rule">
                    <dt>{tOr('PortalMoney.total', 'Total')}</dt>
                    <dd>
                      <bdi>{money(invoice.totalMinor, invoice.currency)}</bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>{tOr('PortalMoney.paidSoFar', 'Paid so far')}</dt>
                    <dd>
                      <bdi>{money(invoice.paidMinor, invoice.currency)}</bdi>
                    </dd>
                  </div>
                  <div className="tm-pm-totals__rule tm-pm-totals__due">
                    <dt>{tOr('PortalMoney.colLeft', 'Left to pay')}</dt>
                    <dd>
                      <bdi>{money(invoice.amountDueMinor, invoice.currency)}</bdi>
                    </dd>
                  </div>
                </dl>
                {invoice.taxNotice ? <p className="tm-pm-notice">{invoice.taxNotice}</p> : null}
              </div>
            </section>

            <aside className="tm-pt-col tm-pm-side">
              <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-pm-summary">
                <h2 id="tm-pm-summary" className="tm-pt-card__title">
                  {tOr('PortalMoney.summary', 'Summary')}
                </h2>
                <dl className="tm-pm-facts">
                  {invoice.issueDate ? (
                    <div>
                      <dt>{tOr('PortalMoney.issued', 'Issued')}</dt>
                      <dd>{when(invoice.issueDate)}</dd>
                    </div>
                  ) : null}
                  {invoice.dueDate ? (
                    <div>
                      <dt>{tOr('PortalMoney.colDue', 'Due')}</dt>
                      <dd>{when(invoice.dueDate)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{tOr('PortalMoney.currency', 'Currency')}</dt>
                    <dd>
                      <bdi>{invoice.currency}</bdi>
                    </dd>
                  </div>
                  {invoice.taxRegistrationRef ? (
                    <div>
                      <dt>
                        {tOr(
                          'PortalMoney.taxRegistrationOf',
                          '{provider} tax registration',
                        ).replace('{provider}', providerName)}
                      </dt>
                      <dd>
                        <bdi>{invoice.taxRegistrationRef}</bdi>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </section>

              <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-pm-payments">
                <h2 id="tm-pm-payments" className="tm-pt-card__title">
                  {tOr('PortalMoney.payments', 'Payments')}
                </h2>
                {invoice.payments.length === 0 ? (
                  <p className="tm-pt-card__body">
                    {tOr('PortalMoney.noPayments', 'No payments yet.')}
                  </p>
                ) : (
                  <dl className="tm-pm-facts">
                    {invoice.payments.map((payment, index) => (
                      <div key={`${payment.paidOn}:${index}`}>
                        <dt>{when(payment.paidOn)}</dt>
                        <dd>
                          <bdi>{money(payment.amountMinor, invoice.currency)}</bdi>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {invoice.notes ? (
                  <>
                    <p className="tm-pt-eyebrow">
                      {tOr('PortalMoney.noteFrom', 'Note from {provider}').replace(
                        '{provider}',
                        providerName,
                      )}
                    </p>
                    <p className="tm-pt-card__body tm-pm-note">{invoice.notes}</p>
                  </>
                ) : null}
              </section>
            </aside>
          </div>
        ) : null}
      </div>
    </ClientPortalShell>
  );
}
