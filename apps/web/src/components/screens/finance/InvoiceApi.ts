import type { ApiClient } from '../../../lib/api/client';

/**
 * Client invoices (52-09): `GET …/client-invoices`, `GET …/client-invoices/:id` and the aging roll-up
 * `GET …/client-invoices/aging`, all on `finance.view`. Money is integer minor units, never a float.
 * The shapes mirror the API's `InvoiceSummary`, `InvoiceView` and `AgingView`; only the fields these
 * screens read are declared.
 */

export type ClientInvoiceState = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'void';

export interface ClientInvoiceRow {
  readonly id: string;
  readonly number: string | null;
  readonly clientOrganizationId: string;
  readonly kind: string;
  readonly state: string;
  readonly currency: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly amountDueMinor: number;
  readonly overdue: boolean;
}

export interface ClientInvoiceDocument extends ClientInvoiceRow {
  readonly documentLabel: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly depositAppliedMinor: number;
  readonly poNumber: string | null;
  readonly notes: string | null;
  readonly sentAt: string | null;
  readonly sentTo: string | null;
  readonly paidAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly descriptionEn: string | null;
    readonly descriptionAr: string | null;
    readonly quantity: number;
    readonly unit: string;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly lineGrossMinor: number;
  }[];
  readonly payments: readonly {
    readonly id: string;
    readonly paidOn: string;
    readonly amountMinor: number;
    readonly method: string;
    readonly reference: string | null;
  }[];
  readonly creditNotes: readonly {
    readonly id: string;
    readonly number: string;
    readonly reason: string;
    readonly totalMinor: number;
    readonly issuedAt: string;
  }[];
}

export type AgingBucketKey = '0_30' | '31_60' | '61_90' | '90_plus';

export interface InvoiceAging {
  readonly asOf: string;
  readonly currencies: readonly {
    readonly currency: string;
    readonly buckets: Readonly<Record<AgingBucketKey, number>>;
    readonly totalMinor: number;
    readonly invoiceCount: number;
  }[];
}

export interface ClientInvoicePage {
  readonly invoices: readonly ClientInvoiceRow[];
  readonly nextCursor: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-invoices`;
}

export async function listClientInvoices(
  client: ApiClient,
  organizationSlug: string,
  filter: { readonly state?: string | null; readonly cursor?: string | null } = {},
): Promise<ClientInvoicePage> {
  const query = new URLSearchParams();
  if (filter.state) query.set('state', filter.state);
  if (filter.cursor) query.set('cursor', filter.cursor);
  const suffix = query.toString();
  const { data } = await client.request<ClientInvoicePage>({
    path: `${base(organizationSlug)}${suffix === '' ? '' : `?${suffix}`}`,
  });
  return data;
}

export async function getClientInvoice(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
): Promise<ClientInvoiceDocument> {
  const { data } = await client.request<ClientInvoiceDocument>({
    path: `${base(organizationSlug)}/${encodeURIComponent(invoiceId)}`,
  });
  return data;
}

export async function getInvoiceAging(
  client: ApiClient,
  organizationSlug: string,
): Promise<InvoiceAging> {
  const { data } = await client.request<InvoiceAging>({
    path: `${base(organizationSlug)}/aging`,
  });
  return data;
}
