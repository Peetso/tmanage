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
  readonly language: string;
  readonly version: number;
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
    readonly sourceType: string;
    readonly descriptionEn: string | null;
    readonly descriptionAr: string | null;
    readonly quantity: number;
    readonly unit: string;
    readonly unitPriceMinor: number;
    readonly discountBp: number;
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

// ---- writes (52-09 editor, send and payment; all `finance.manage`, re-checked by the service) ----

/** One line as the API's `PUT …/client-invoices/:id` takes it; the server recomputes every total. */
export interface InvoiceLineBody {
  readonly id: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly quantity: number;
  readonly unit: string;
  readonly unitPriceMinor: number;
  readonly discountBp: number;
  readonly taxBp: number;
}

export interface InvoiceCreateBody {
  readonly clientOrganizationId: string;
  readonly currency: string | null;
  readonly issueDate: string | null;
}

export interface InvoicePatchBody {
  readonly expectedVersion: number;
  readonly issueDate?: string;
  readonly dueDate?: string;
  readonly lines?: readonly InvoiceLineBody[];
}

export interface InvoicePullBody {
  readonly period: { readonly from: string; readonly to: string };
  readonly include: {
    readonly time: boolean;
    readonly expenses: boolean;
    readonly retainer: boolean;
  };
}

export interface InvoicePullResult {
  readonly invoice: ClientInvoiceDocument;
  readonly waiting: { readonly minutes: number };
  readonly unpriced: { readonly minutes: number };
}

export interface InvoicePaymentBody {
  readonly paidOn: string;
  readonly amountMinor: number;
  readonly method: string;
  readonly reference: string | null;
}

export async function createClientInvoice(
  client: ApiClient,
  organizationSlug: string,
  body: InvoiceCreateBody,
): Promise<ClientInvoiceDocument> {
  const { data } = await client.request<ClientInvoiceDocument>({
    method: 'POST',
    path: base(organizationSlug),
    body,
  });
  return data;
}

export async function updateClientInvoice(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
  body: InvoicePatchBody,
): Promise<ClientInvoiceDocument> {
  const { data } = await client.request<ClientInvoiceDocument>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(invoiceId)}`,
    body,
  });
  return data;
}

/** Brings approved time, approved expenses and the retainer period onto a draft (idempotent). */
export async function pullInvoiceLines(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
  body: InvoicePullBody,
): Promise<InvoicePullResult> {
  const { data } = await client.request<InvoicePullResult>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(invoiceId)}/pull`,
    body: {
      period: body.period,
      include: {
        time: body.include.time ? 'by_task' : false,
        expenses: body.include.expenses,
        retainer: body.include.retainer,
      },
    },
  });
  return data;
}

/**
 * Issues the draft and e-mails each recipient the link to the invoice. The same `idempotencyKey`
 * makes a retry answer the first send instead of a 409.
 */
export async function sendClientInvoice(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
  body: { readonly to: readonly string[]; readonly message: string | null },
  idempotencyKey: string,
): Promise<ClientInvoiceDocument> {
  const { data } = await client.request<ClientInvoiceDocument>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(invoiceId)}/send`,
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return data;
}

export async function recordInvoicePayment(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
  body: InvoicePaymentBody,
): Promise<ClientInvoiceDocument> {
  const { data } = await client.request<ClientInvoiceDocument>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(invoiceId)}/payments`,
    body,
  });
  return data;
}

/** The API's HTML print view (A4, AR/EN) — "Save as PDF" from the browser's print dialog. */
export function invoicePrintUrl(
  apiOrigin: string,
  organizationSlug: string,
  invoiceId: string,
  language: 'en' | 'ar',
): string {
  return `${apiOrigin.replace(/\/+$/u, '')}${base(organizationSlug)}/${encodeURIComponent(invoiceId)}/print?lang=${language}`;
}
