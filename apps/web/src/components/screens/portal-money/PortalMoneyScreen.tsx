'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../../shell/ClientPortalShell';
import { useSelectedPortalProject } from '../../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listPortalProjects } from '../../../lib/api/portal';
import {
  getPortalBudget,
  listPortalInvoices,
  listPortalRetainers,
  type PortalInvoiceSummary,
} from '../../../lib/api/portal-money';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { usePortalNames } from '../../../lib/use-organization-names';
import { shortDay } from '../PortalParts';
import {
  BudgetCard,
  DownloadPdfLink,
  RetainerCard,
  StandingCapsule,
  describeMoneyError,
  isNotFound,
  useCount,
  useMoney,
} from './PortalMoneyParts';

export interface PortalMoneyScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/** What is left to pay, per currency (an account is nearly always in one). */
function outstanding(
  invoices: readonly PortalInvoiceSummary[],
): { currency: string; minor: number }[] {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.amountDueMinor <= 0) continue;
    totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + invoice.amountDueMinor);
  }
  return [...totals].map(([currency, minor]) => ({ currency, minor }));
}

/** Newest first: by issue date, then by number. */
function newestFirst(invoices: readonly PortalInvoiceSummary[]): PortalInvoiceSummary[] {
  return [...invoices].sort(
    (a, b) =>
      (b.issueDate ?? '').localeCompare(a.issueDate ?? '') ||
      (b.number ?? '').localeCompare(a.number ?? ''),
  );
}

/**
 * **52-13 Money** — the client's invoices and how much of its retainer and budget is used
 * (Figma 627:35481 / 627:35855 / 627:35995 / 627:35776).
 *
 * What the client owes and what is late lead the header; the invoice list follows with where each
 * one stands (worked out by the API on the workspace's calendar); "This period" shows the retainer
 * hours and the shared project's budget share. Only what the portal reads return is shown: no
 * cost, rate or margin, and nothing the API does not send.
 */
export function PortalMoneyScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalMoneyScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const count = useCount();
  const money = useMoney();

  const invoices = useQuery({
    queryKey: ['portal-invoices', organizationSlug],
    queryFn: () => listPortalInvoices(api, organizationSlug),
  });
  const retainers = useQuery({
    queryKey: ['portal-retainers', organizationSlug],
    queryFn: () => listPortalRetainers(api, organizationSlug),
  });
  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });
  const project = useSelectedPortalProject(projects.data);
  const budget = useQuery({
    queryKey: ['portal-budget', organizationSlug, project?.id],
    queryFn: () => getPortalBudget(api, organizationSlug, project!.id),
    enabled: project != null,
    retry: (failures, error) => !isNotFound(error) && failures < 2,
  });

  const rows = newestFirst(invoices.data ?? []);
  const owed = outstanding(rows);
  const toPay = rows.filter((invoice) => invoice.amountDueMinor > 0);
  const late = rows.filter((invoice) => invoice.standing.kind === 'overdue');

  const description =
    invoices.data === undefined || toPay.length === 0
      ? tOr(
          'PortalMoney.summaryNone',
          'Your invoices, and how much of your retainer and budget is used.',
        )
      : [
          count(
            'PortalMoney.invoicesToPay',
            toPay.length,
            'You have {count} invoice to pay, {amount} in total.',
            'You have {count} invoices to pay, {amount} in total.',
          ).replace('{amount}', owed.map((o) => money(o.minor, o.currency)).join(' + ')),
          late.length > 0
            ? count(
                'PortalMoney.pastDue',
                late.length,
                'One is past its due date.',
                '{count} are past their due date.',
              )
            : '',
        ]
          .filter(Boolean)
          .join(' ');

  const periodCards = [
    ...(retainers.data ?? []).map((retainer) => (
      <RetainerCard key={retainer.id} retainer={retainer} />
    )),
    ...(project && budget.data
      ? [<BudgetCard key="budget" projectName={project.name} budget={budget.data} />]
      : []),
  ];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="money"
      title={tOr('PortalMoney.title', 'Money')}
      eyebrow={`${tOr('PortalMoney.eyebrow', 'Your account with')} ${providerName}`}
      description={description}
      headerAside={
        owed.length > 0 ? (
          <div className="tm-pt-metrics tm-pm-owed">
            {owed.map((o) => (
              <section
                key={o.currency}
                className="tm-pt-metric"
                aria-label={tOr('PortalMoney.leftToPay', 'left to pay')}
              >
                <p className="tm-pt-metric__value">
                  <bdi>{money(o.minor, o.currency)}</bdi>
                </p>
                <p className="tm-pt-metric__label">{tOr('PortalMoney.leftToPay', 'left to pay')}</p>
                <p className="tm-pt-metric__source">
                  {late.length > 0
                    ? count(
                        'PortalMoney.overdueCount',
                        late.length,
                        '{count} invoice is overdue',
                        '{count} invoices are overdue',
                      )
                    : tOr('PortalMoney.nothingOverdue', 'Nothing is overdue')}
                </p>
              </section>
            ))}
          </div>
        ) : undefined
      }
    >
      <div className="tm-pt tm-pt--compact tm-pm">
        <section className="tm-pt-col tm-pm-invoices" aria-labelledby="tm-pm-invoices">
          <div className="tm-pm-section-head">
            <h2 id="tm-pm-invoices" className="tm-pt-section-title">
              {tOr('PortalMoney.invoices', 'Invoices')}
            </h2>
            {toPay.length > 0 ? (
              <p className="tm-pm-section-head__aside">
                {tOr('PortalMoney.newestFirst', 'Newest first')}
              </p>
            ) : null}
          </div>

          {invoices.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('PortalMoney.couldNotLoad', 'We could not load your invoices')}
              live
            >
              {describeMoneyError(invoices.error, tOr)}
            </InlineAlert>
          ) : null}

          {invoices.isPending ? (
            <LoadingRegion label={tOr('PortalMoney.loading', 'Loading your invoices')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {invoices.isSuccess && toPay.length === 0 ? (
            <div className="tm-pt-card tm-pt-card--lg tm-pm-empty">
              <span className="tm-pm-empty__mark" aria-hidden="true">
                ✓
              </span>
              <h3 className="tm-pm-empty__title">
                {tOr('PortalMoney.emptyTitle', 'Nothing to pay right now')}
              </h3>
              <p className="tm-pt-card__body">
                {(rows.length === 0
                  ? tOr(
                      'PortalMoney.emptyNone',
                      'There are no invoices from {provider} yet. When one arrives, it shows up here.',
                    )
                  : tOr(
                      'PortalMoney.emptyPaid',
                      'Every invoice from {provider} is paid. When a new one arrives, it shows up here.',
                    )
                ).replace('{provider}', providerName)}
              </p>
            </div>
          ) : null}

          {invoices.isSuccess && toPay.length > 0 ? (
            <InvoiceTable organizationSlug={organizationSlug} invoices={rows} />
          ) : null}

          {invoices.isSuccess && rows.length > 0 ? (
            <p className="tm-pm-footnote">
              {tOr('PortalMoney.questionLead', 'A question about an invoice?')}{' '}
              <Link href={`/${organizationSlug}/portal/requests/new`}>
                {tOr('PortalMoney.questionLink', 'Send {provider} a message.').replace(
                  '{provider}',
                  providerName,
                )}
              </Link>
            </p>
          ) : null}
        </section>

        <section className="tm-pt-col tm-pm-period" aria-labelledby="tm-pm-period">
          <h2 id="tm-pm-period" className="tm-pt-section-title">
            {tOr('PortalMoney.thisPeriod', 'This period')}
          </h2>
          {retainers.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('PortalMoney.couldNotLoadRetainer', 'We could not load your retainer')}
              live
            >
              {describeMoneyError(retainers.error, tOr)}
            </InlineAlert>
          ) : null}
          {retainers.isPending ? (
            <LoadingRegion label={tOr('PortalMoney.loadingPeriod', 'Loading this period')}>
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}
          {periodCards}
          {retainers.isSuccess && periodCards.length === 0 && !budget.isPending ? (
            <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
              {tOr(
                'PortalMoney.noPeriod',
                'No retainer or shared budget with {provider} right now.',
              ).replace('{provider}', providerName)}
            </p>
          ) : null}
        </section>
      </div>
    </ClientPortalShell>
  );
}

/**
 * The invoice list. A whole row opens the invoice (the number is its link and reads as one); the
 * download is a separate target. On a phone each row is a card (labels from `data-label`).
 */
function InvoiceTable({
  organizationSlug,
  invoices,
}: {
  readonly organizationSlug: string;
  readonly invoices: readonly PortalInvoiceSummary[];
}) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const money = useMoney();
  const router = useRouter();
  const hrefOf = (id: string) => `/${organizationSlug}/portal/money/${encodeURIComponent(id)}`;
  const leftLabel = tOr('PortalMoney.colLeft', 'Left to pay');
  const amountLabel = tOr('PortalMoney.colAmount', 'Amount');
  const dueLabel = tOr('PortalMoney.colDue', 'Due');
  return (
    <div className="tm-pt-card tm-pm-table-card">
      <table className="tm-pm-table">
        <thead>
          <tr>
            <th scope="col">{tOr('PortalMoney.colInvoice', 'Invoice')}</th>
            <th scope="col" className="tm-pm-wide">
              {tOr('PortalMoney.colIssued', 'Issued')}
            </th>
            <th scope="col">{dueLabel}</th>
            <th scope="col" className="tm-pm-wide">
              {amountLabel}
            </th>
            <th scope="col">{leftLabel}</th>
            <th scope="col">{tOr('PortalMoney.colState', 'State')}</th>
            <th scope="col">
              <span className="tm-visually-hidden">
                {tOr('PortalMoney.downloadPdf', 'Download PDF')}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => {
            const settled = invoice.amountDueMinor <= 0;
            return (
              <tr
                key={invoice.id}
                className="tm-pm-row"
                onClick={(event) => {
                  if ((event.target as Element).closest('a')) return;
                  router.push(hrefOf(invoice.id));
                }}
              >
                <th scope="row" className="tm-pm-row__invoice">
                  <Link className="tm-pm-row__link" href={hrefOf(invoice.id)}>
                    <bdi>{invoice.number ?? invoice.documentLabelText}</bdi>
                  </Link>
                  <span className="tm-pm-row__label">{invoice.documentLabelText}</span>
                </th>
                <td className="tm-pm-wide">
                  {invoice.issueDate ? shortDay(invoice.issueDate, locale) : '—'}
                </td>
                <td className="tm-pm-row__due" data-label={dueLabel}>
                  {invoice.dueDate ? shortDay(invoice.dueDate, locale) : '—'}
                </td>
                <td className="tm-pm-wide">
                  <bdi>{money(invoice.totalMinor, invoice.currency)}</bdi>
                </td>
                <td className="tm-pm-row__left" data-label={settled ? amountLabel : leftLabel}>
                  {settled ? (
                    <>
                      <span className="tm-pm-phone">
                        <bdi>{money(invoice.totalMinor, invoice.currency)}</bdi>
                      </span>
                      <span className="tm-pm-desk">—</span>
                    </>
                  ) : (
                    <bdi>{money(invoice.amountDueMinor, invoice.currency)}</bdi>
                  )}
                </td>
                <td className="tm-pm-row__state">
                  <StandingCapsule standing={invoice.standing} />
                </td>
                <td className="tm-pm-row__download">
                  <DownloadPdfLink
                    organizationSlug={organizationSlug}
                    invoiceId={invoice.id}
                    number={invoice.number}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
