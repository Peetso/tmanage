'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listInvoiceLines } from '../../lib/api/invoice-line-items';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/billing.css';

export interface InvoiceLineItemsScreenProps {
  organizationSlug: string;
  organizationName: string;
  invoiceId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Invoice line items** — the per-invoice line breakdown (FEAT module 19, x225). Reads
 * `GET /v1/organizations/:orgSlug/billing/invoices/:invoiceId/lines`, gated on `org.manage`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** The read sits behind `org.manage`; a member without it gets the
 *    ordinary 403, which `describe()` turns into a line rather than a blank page. An unknown or
 *    cross-tenant invoice id is a 404 (resolve-before-authorize). The screen never guesses a
 *    capability of its own.
 * 2. **Read-only.** There is no line mutation surface this slice — the table and its reconciled total
 *    are all there is. Generating invoices and their lines from a payment provider is Needs-Peter.
 * 3. **Money is integer minor units.** Amounts arrive as integer minor units and are formatted for
 *    display with `Intl.NumberFormat`; the screen never does float arithmetic on them.
 */
export function InvoiceLineItemsScreen({
  organizationSlug,
  organizationName,
  invoiceId,
  client,
}: InvoiceLineItemsScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

  const lines = useQuery({
    queryKey: ['billing-invoice-lines', organizationSlug, invoiceId],
    queryFn: () => listInvoiceLines(api, organizationSlug, invoiceId),
  });

  const data = lines.data;

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('InvoiceLineItemsScreen.eyebrow')}
      title={t('InvoiceLineItemsScreen.title')}
      description={t('InvoiceLineItemsScreen.description')}
    >
      <div className="tm-bil">
        {lines.isPending ? (
          <LoadingRegion
            label={t('InvoiceLineItemsScreen.loading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {lines.isError ? (
          <InlineAlert tone="danger" title={t('InvoiceLineItemsScreen.loadErrorTitle')} live>
            {describe(lines.error)}
          </InlineAlert>
        ) : null}

        {data ? (
          <section className="tm-panel tm-stack" aria-labelledby="tm-invoice-lines-heading">
            <div className="tm-row tm-row--wrap">
              <h2 id="tm-invoice-lines-heading" className="tm-eyebrow">
                {t('InvoiceLineItemsScreen.heading')}
              </h2>
              <StatusDot tone={data.reconciled ? 'success' : 'warning'}>
                {data.reconciled
                  ? t('InvoiceLineItemsScreen.reconciled')
                  : t('InvoiceLineItemsScreen.doesNotReconcile')}
              </StatusDot>
            </div>

            {data.lineItems.length > 0 ? (
              <table className="tm-table" aria-label={t('InvoiceLineItemsScreen.tableLabel')}>
                <thead>
                  <tr>
                    <th scope="col">{t('InvoiceLineItemsScreen.colDescription')}</th>
                    <th scope="col">{t('InvoiceLineItemsScreen.colQty')}</th>
                    <th scope="col">{t('InvoiceLineItemsScreen.colUnit')}</th>
                    <th scope="col">{t('InvoiceLineItemsScreen.colAmount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lineItems.map((item) => (
                    <tr key={item.id}>
                      <td>{item.description}</td>
                      <td className="tm-mono">{item.quantity}</td>
                      <td className="tm-mono">
                        {formatMoney(item.unitAmountCents, data.currency)}
                      </td>
                      <td className="tm-mono">{formatMoney(item.amountCents, data.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={3}>
                      {t('InvoiceLineItemsScreen.linesTotal')}
                    </th>
                    <td className="tm-mono">{formatMoney(data.lineTotalCents, data.currency)}</td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={3}>
                      {t('InvoiceLineItemsScreen.invoiceTotal')}
                    </th>
                    <td className="tm-mono">
                      {formatMoney(data.invoiceTotalCents, data.currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <InlineAlert tone="neutral">{t('InvoiceLineItemsScreen.empty')}</InlineAlert>
            )}
          </section>
        ) : null}
      </div>
    </SettingsShell>
  );
}

/** Format integer minor units as a currency amount. Never does float arithmetic beyond the /100. */
function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
