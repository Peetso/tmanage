import type { ApiClient } from '../../../lib/api/client';

/**
 * Quotes (52-08): `GET|POST …/quotes`, `GET|PUT …/quotes/:id`, `POST …/quotes/:id/send`, all on
 * `project.manage`, and `POST …/quotes/:id/convert` (52-08 convert to project); and the outsider side, the 56-07 link `GET|POST /v1/public/links/:token…`
 * with no session. Money is integer minor units; a quantity is a number with at most two decimals.
 * The shapes mirror the API's `QuoteView`, `QuoteDetail`, `SentQuote` and `OutsiderLinkView`.
 */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

export interface QuoteRow {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly status: QuoteStatus;
  readonly clientOrganizationId: string | null;
  readonly leadName: string | null;
  readonly leadEmail: string | null;
  readonly language: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly sentAt: string | null;
  readonly decidedAt: string | null;
  /** 0331. The project this accepted quote became (absent from an older API: treated as none). */
  readonly convertedProjectId?: string | null;
  readonly version: number;
}

export interface QuoteLine {
  readonly position: number;
  readonly description: string;
  readonly unit: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly taxBp: number;
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
}

export interface QuoteDocument extends QuoteRow {
  readonly terms: string | null;
  readonly notes: string | null;
  readonly lines: readonly QuoteLine[];
}

/** The body `POST` and `PUT` take. Totals are never sent: the server computes them. */
export interface QuoteInput {
  readonly clientOrganizationId: string | null;
  readonly leadName: string | null;
  readonly leadEmail: string | null;
  readonly title: string;
  readonly language: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly terms: string | null;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly unit: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
  }[];
  readonly version?: number;
}

export interface SentQuote {
  readonly quote: QuoteRow;
  readonly link: { readonly id: string; readonly token: string; readonly expiresAt: string };
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/quotes`;
}

export async function listQuotes(
  client: ApiClient,
  organizationSlug: string,
  status: QuoteStatus | null,
): Promise<readonly QuoteRow[]> {
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  const { data } = await client.request<{ quotes: readonly QuoteRow[] }>({
    path: `${base(organizationSlug)}?${query.toString()}`,
  });
  return data.quotes;
}

export async function getQuote(
  client: ApiClient,
  organizationSlug: string,
  quoteId: string,
): Promise<QuoteDocument> {
  const { data } = await client.request<QuoteDocument>({
    path: `${base(organizationSlug)}/${encodeURIComponent(quoteId)}`,
  });
  return data;
}

/** `POST …/quotes/:id/convert`. Mirrors the API's `ConvertedQuote`; a second call returns the same project. */
export interface ConvertedQuote {
  readonly quote: QuoteRow;
  readonly projectId: string;
  readonly created: boolean;
}

export async function convertQuote(
  client: ApiClient,
  organizationSlug: string,
  quoteId: string,
): Promise<ConvertedQuote> {
  const { data } = await client.request<ConvertedQuote>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(quoteId)}/convert`,
    body: {},
  });
  return data;
}

export async function saveQuote(
  client: ApiClient,
  organizationSlug: string,
  quoteId: string | null,
  body: QuoteInput,
): Promise<QuoteDocument> {
  const { data } = await client.request<QuoteDocument>({
    method: quoteId === null ? 'POST' : 'PUT',
    path:
      quoteId === null
        ? base(organizationSlug)
        : `${base(organizationSlug)}/${encodeURIComponent(quoteId)}`,
    body,
  });
  return data;
}

export async function sendQuote(
  client: ApiClient,
  organizationSlug: string,
  quoteId: string,
  to: string,
): Promise<SentQuote> {
  const { data } = await client.request<SentQuote>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(quoteId)}/send`,
    body: { to },
  });
  return data;
}

/** 52-10 — the quote as a PDF in its own language (`project.manage`), relative to the API origin. */
export function quotePdfPath(organizationSlug: string, quoteId: string): string {
  return `${base(organizationSlug)}/${encodeURIComponent(quoteId)}/pdf`;
}

/** Fix lane C. `DELETE …/quotes/:quoteId` (204) — a draft only; a sent quote is 409 `not_draft`. */
export async function deleteQuote(
  client: ApiClient,
  organizationSlug: string,
  quoteId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(quoteId)}`,
  });
}

// ── the client's side: the quote link ──────────────────────────────────────

/** The client-safe projection the `quote` link target shows: no ids, no internal notes. */
export interface PublicQuoteProjection {
  readonly number: string;
  readonly title: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly terms: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly unit: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly lineNetMinor: number;
    readonly lineTaxMinor: number;
  }[];
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export type QuoteLinkView =
  | { readonly state: 'expired' | 'revoked' | 'superseded' }
  | { readonly state: 'decided'; readonly decision: string; readonly decidedAt: string }
  | {
      readonly state: 'active';
      readonly kind: string;
      readonly organizationName: string;
      readonly language: string;
      readonly decisions: readonly string[];
      readonly codeRequiredFor: readonly string[];
      readonly projection: PublicQuoteProjection;
    };

function linkPath(token: string): string {
  return `/v1/public/links/${encodeURIComponent(token)}`;
}

export async function openQuoteLink(client: ApiClient, token: string): Promise<QuoteLinkView> {
  const { data } = await client.request<QuoteLinkView>({
    path: linkPath(token),
    authentication: 'none',
  });
  return data;
}

export async function requestQuoteCode(client: ApiClient, token: string): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${linkPath(token)}/code`,
    body: {},
    authentication: 'none',
  });
}

export async function decideQuote(
  client: ApiClient,
  token: string,
  body: {
    readonly decision: 'accept' | 'decline';
    readonly code?: string;
    readonly comment?: string;
  },
): Promise<{ readonly state: 'decided'; readonly decision: string; readonly decidedAt: string }> {
  const { data } = await client.request<{
    readonly state: 'decided';
    readonly decision: string;
    readonly decidedAt: string;
  }>({
    method: 'POST',
    path: `${linkPath(token)}/decision`,
    body,
    authentication: 'none',
  });
  return data;
}
