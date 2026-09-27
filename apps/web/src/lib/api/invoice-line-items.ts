import type { ApiClient } from './client';

/**
 * The per-invoice line-item endpoint — FEAT module 19 (x225), gated on `org.manage`.
 *
 * Read-only: one invoice's line breakdown plus its reconciliation to the header total. Hand-written
 * for the boundary reason `errors.ts` gives, and paired with the API projections
 * (`InvoiceLineItemView`, `InvoiceLinesView`) in the `e2e/contracts` shape check so the two cannot
 * drift. The read is tenant-scoped on the server from the caller's membership — there is no
 * organization argument here beyond the slug in the path. Money is integer minor units
 * (`amountCents`), never a float.
 */

/**
 * One billed line of an invoice. Paired Exact with the API's `InvoiceLineItemView`. `unitAmountCents`
 * and `amountCents` are integer counts of the smallest currency unit.
 */
export interface InvoiceLineItem {
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly amountCents: number;
}

/**
 * An invoice's line breakdown with its reconciliation. Paired Exact with the API's
 * `InvoiceLinesView`. `lineTotalCents` is the sum of `lineItems[].amountCents`; `invoiceTotalCents`
 * is the stored header total; `reconciled` is whether they agree.
 */
export interface InvoiceLines {
  readonly invoiceId: string;
  readonly currency: string;
  readonly invoiceTotalCents: number;
  readonly lineTotalCents: number;
  readonly reconciled: boolean;
  readonly lineItems: readonly InvoiceLineItem[];
}

export async function listInvoiceLines(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
): Promise<InvoiceLines> {
  const { data } = await client.request<InvoiceLines>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/invoices/${encodeURIComponent(invoiceId)}/lines`,
  });
  return data;
}
