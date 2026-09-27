import type { ApiClient } from './client';

/**
 * The billing invoice-history endpoints — FEAT module 19 (x179), gated on `org.manage`.
 *
 * Read-only: a tenant-scoped list and a by-id detail. Hand-written for the boundary reason
 * `errors.ts` gives, and paired with the API projections (`InvoiceView`, `InvoiceDetailView`) in the
 * `e2e/contracts` shape check so the two cannot drift. The read is tenant-scoped on the server from
 * the caller's membership — there is no organization argument here beyond the slug in the path.
 * Money is integer cents (`amountCents`), never a float.
 */

/** An invoice's state, mirroring the API's `InvoiceStatus`. */
export type InvoiceStatus = 'paid' | 'open' | 'void';

/**
 * One row of the history list. Paired Exact with the API's `InvoiceView`. `amountCents` is an integer
 * count of the smallest unit of `currency`; the period bounds and `issuedAt` are ISO-8601 instants.
 */
export interface InvoiceSummary {
  readonly id: string;
  readonly number: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
}

/**
 * An invoice's detail — the summary plus the line-item breakdown and the row's creation time. Paired
 * Exact with the API's `InvoiceDetailView`. The line-item shape is inline and unexported on purpose:
 * a named exported member would be enumerated by `contracts:check` as its own response projection
 * needing a pair, and it is not one — it is a member of this detail.
 */
export interface InvoiceDetail extends InvoiceSummary {
  readonly lineItems: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unitAmountCents: number;
    readonly amountCents: number;
  }[];
  readonly createdAt: string;
}

/** The largest page the history route returns — the API's `MAX_PAGE_SIZE`. */
export const MAX_INVOICES_PAGE = 100;

export interface ListInvoicesOptions {
  /** `1..100`; the API defaults to 50 and clamps out-of-range values. */
  readonly limit?: number;
}

export async function listInvoices(
  client: ApiClient,
  organizationSlug: string,
  options: ListInvoicesOptions = {},
): Promise<readonly InvoiceSummary[]> {
  const parameters = new URLSearchParams();
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));
  const query = parameters.toString();

  const { data } = await client.request<{ invoices: readonly InvoiceSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/invoices${query === '' ? '' : `?${query}`}`,
  });
  return data.invoices;
}

export async function getInvoice(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
): Promise<InvoiceDetail> {
  const { data } = await client.request<InvoiceDetail>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/invoices/${encodeURIComponent(invoiceId)}`,
  });
  return data;
}
