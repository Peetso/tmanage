import type { BurnStatus, InvoiceStanding } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * 52-13 — the client portal's Money reads: the client's own invoices, its retainers and a shared
 * project's budget. Every route is a `client_projection.read` read of the signed-in client's own
 * organization; another client's id answers 404. No cost, rate, margin or member id is ever sent.
 */

/** One invoice as the client sees it (`GET …/portal/invoices/:invoiceId`). */
export interface PortalInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly kind: string;
  readonly language: string;
  readonly state: string;
  readonly documentLabel: string;
  /** The label in the invoice's language ("Tax invoice"). */
  readonly documentLabelText: string;
  /** The "not a tax invoice" line when it went out with the document, else null. */
  readonly taxNotice: string | null;
  /** The agency's registered tax reference as it entered it, else null. */
  readonly taxRegistrationRef: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly amountDueMinor: number;
  /** Paid / overdue N days / due in N days / open — worked out on the workspace's calendar. */
  readonly standing: InvoiceStanding;
  /** The agency's note to the client, else null. */
  readonly notes: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unit: string;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly netMinor: number;
    readonly grossMinor: number;
  }[];
  readonly payments: readonly {
    readonly paidOn: string;
    readonly amountMinor: number;
    readonly method: string;
  }[];
}

/** A row of the client's invoice list: the header without lines, payments or the note. */
export type PortalInvoiceSummary = Omit<PortalInvoice, 'lines' | 'payments' | 'notes'>;

/** One of the client's retainers, this period (`GET …/portal/retainers`). Hours only. */
export interface PortalRetainer {
  readonly id: string;
  readonly name: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly allowanceHours: number;
  readonly usedHours: number;
  readonly remainingHours: number;
  readonly renewsOn: string | null;
}

/** A shared project's budget as the client sees it: a share and a status, never an amount. */
export interface PortalBudget {
  readonly percentUsed: number;
  readonly remainingHours?: number;
  readonly status: BurnStatus;
}

const portalPath = (organizationSlug: string): string =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal`;

export async function listPortalInvoices(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly PortalInvoiceSummary[]> {
  const { data } = await client.request<{ invoices: readonly PortalInvoiceSummary[] }>({
    path: `${portalPath(organizationSlug)}/invoices`,
  });
  return data.invoices;
}

export async function getPortalInvoice(
  client: ApiClient,
  organizationSlug: string,
  invoiceId: string,
): Promise<PortalInvoice> {
  const { data } = await client.request<PortalInvoice>({
    path: `${portalPath(organizationSlug)}/invoices/${encodeURIComponent(invoiceId)}`,
  });
  return data;
}

export async function listPortalRetainers(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly PortalRetainer[]> {
  const { data } = await client.request<{ retainers: readonly PortalRetainer[] }>({
    path: `${portalPath(organizationSlug)}/retainers`,
  });
  return data.retainers;
}

export async function getPortalBudget(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<PortalBudget> {
  const { data } = await client.request<PortalBudget>({
    path: `${portalPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/budget`,
  });
  return data;
}

/**
 * "Download PDF" (52-10): the API's PDF of the client's own invoice (`attachment`), drawn on the
 * server behind the same checks as the read. Opened with the session cookie.
 */
export function portalInvoicePdfUrl(
  apiOrigin: string,
  organizationSlug: string,
  invoiceId: string,
  language: 'en' | 'ar',
): string {
  return `${apiOrigin.replace(/\/+$/u, '')}${portalPath(organizationSlug)}/invoices/${encodeURIComponent(invoiceId)}/pdf?lang=${language}`;
}
