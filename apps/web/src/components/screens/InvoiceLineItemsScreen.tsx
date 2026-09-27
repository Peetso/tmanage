'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listInvoiceLines } from '../../lib/api/invoice-line-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();

  const lines = useQuery({
    queryKey: ['billing-invoice-lines', organizationSlug, invoiceId],
    queryFn: () => listInvoiceLines(api, organizationSlug, invoiceId),
  });

  const data = lines.data;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Invoice line items"
      description="The line breakdown for this invoice, reconciled to its total."
    >
      {lines.isPending ? (
        <LoadingRegion label="Loading line items." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {lines.isError ? (
        <InlineAlert tone="danger" title="Could not load line items" live>
          {describe(lines.error)}
        </InlineAlert>
      ) : null}

      {data ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-invoice-lines-heading">
          <div className="tm-row tm-row--wrap">
            <h2 id="tm-invoice-lines-heading" className="tm-eyebrow">
              Line items
            </h2>
            <StatusDot tone={data.reconciled ? 'success' : 'warning'}>
              {data.reconciled ? 'Reconciled' : 'Does not reconcile'}
            </StatusDot>
          </div>

          {data.lineItems.length > 0 ? (
            <table className="tm-table" aria-label="Invoice line items">
              <thead>
                <tr>
                  <th scope="col">Description</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.lineItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td className="tm-mono">{item.quantity}</td>
                    <td className="tm-mono">{formatMoney(item.unitAmountCents, data.currency)}</td>
                    <td className="tm-mono">{formatMoney(item.amountCents, data.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>
                    Lines total
                  </th>
                  <td className="tm-mono">{formatMoney(data.lineTotalCents, data.currency)}</td>
                </tr>
                <tr>
                  <th scope="row" colSpan={3}>
                    Invoice total
                  </th>
                  <td className="tm-mono">{formatMoney(data.invoiceTotalCents, data.currency)}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <InlineAlert tone="neutral">This invoice has no line-item breakdown.</InlineAlert>
          )}
        </section>
      ) : null}
    </AppShell>
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

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
