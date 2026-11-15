import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * 52-26 — simple electronic signature.
 *
 * Staff routes live under `/v1/organizations/:org/signature-requests`, the signer's under
 * `/v1/organizations/:org/portal/signature-requests`. The view types below mirror the API's
 * `approvals/esign.ts` field for field and are paired `Exact` in `e2e/contracts/api-web-shapes.ts`.
 */

export type SignatureState = 'pending' | 'signed' | 'expired' | 'cancelled';
export type SignatureMethod = 'typed' | 'drawn';

/** The portal's view of one request addressed to the caller. */
export interface PortalSignatureView {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly deliverableVersionId: string;
  readonly fileVersionId: string | null;
  readonly organizationName: string;
  readonly state: SignatureState;
  readonly signedAt: string | null;
  readonly expiresAt: string;
  /** The signer's e-mail, masked (`l•••@example.com`). */
  readonly emailHint: string;
  /** A code was sent and is still live. */
  readonly codeLive: boolean;
  readonly signerName: string;
  readonly consentText: string;
  readonly consentTextVersion: string;
}

export interface PortalSignatureListView {
  readonly requests: readonly PortalSignatureView[];
}

export interface SignatureCodeSentView {
  readonly emailHint: string;
  readonly expiresInSeconds: number;
  readonly resendAfterSeconds: number;
}

/** The sealed record of one signer, as the team sees it. */
export interface SignatureRecordSummary {
  readonly recordNo: number;
  readonly recordHash: string;
  /** Hash, chain link and signature all hold. */
  readonly intact: boolean;
  readonly email: string;
  readonly method: SignatureMethod;
  readonly typedName: string | null;
  readonly codeVerifiedAt: string;
  readonly signedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly contentHash: string;
  readonly consentTextVersion: string;
}

export interface SignatureSignerView {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationName: string;
  readonly status: 'pending' | 'signed';
  readonly viewedAt: string | null;
  readonly signedAt: string | null;
  readonly record: SignatureRecordSummary | null;
}

export interface SignatureRequestView {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  /** The version still hashes to what the request pinned. */
  readonly documentUnchanged: boolean;
  readonly state: 'pending' | 'completed' | 'cancelled' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signedCount: number;
  readonly signers: readonly SignatureSignerView[];
}

export interface SignatureRequestListView {
  readonly requests: readonly SignatureRequestView[];
}

export interface CreateSignatureRequestInput {
  readonly deliverableVersionId: string;
  readonly signerUserIds: readonly string[];
  readonly expiresInDays?: number;
  readonly title?: string;
}

export interface SignInput {
  readonly method: SignatureMethod;
  readonly typedName?: string;
  /** Raw base64 PNG, no `data:` prefix. */
  readonly markPng?: string;
  readonly consent: true;
  readonly code: string;
}

function staffPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/signature-requests`;
}

function portalPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/signature-requests`;
}

export async function createSignatureRequest(
  client: ApiClient,
  organizationSlug: string,
  input: CreateSignatureRequestInput,
): Promise<SignatureRequestView> {
  const { data } = await client.request<SignatureRequestView>({
    method: 'POST',
    path: staffPath(organizationSlug),
    body: input,
  });
  return data;
}

export async function listSignatureRequests(
  client: ApiClient,
  organizationSlug: string,
  deliverableVersionId: string,
): Promise<SignatureRequestListView> {
  const query = `?deliverableVersionId=${encodeURIComponent(deliverableVersionId)}`;
  const { data } = await client.request<SignatureRequestListView>({
    path: `${staffPath(organizationSlug)}${query}`,
  });
  return data;
}

export async function getSignatureRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<SignatureRequestView> {
  const { data } = await client.request<SignatureRequestView>({
    path: `${staffPath(organizationSlug)}/${encodeURIComponent(requestId)}`,
  });
  return data;
}

export async function cancelSignatureRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<SignatureRequestView> {
  const { data } = await client.request<SignatureRequestView>({
    method: 'POST',
    path: `${staffPath(organizationSlug)}/${encodeURIComponent(requestId)}/cancel`,
  });
  return data;
}

/** Reminds the pending signers; 429 `rate_limited` when reminded in the last 24 hours. */
export async function remindSignatureRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<SignatureRequestView> {
  const { data } = await client.request<SignatureRequestView>({
    method: 'POST',
    path: `${staffPath(organizationSlug)}/${encodeURIComponent(requestId)}/remind`,
  });
  return data;
}

export async function listPortalSignatureRequests(
  client: ApiClient,
  organizationSlug: string,
): Promise<PortalSignatureListView> {
  const { data } = await client.request<PortalSignatureListView>({
    path: portalPath(organizationSlug),
  });
  return data;
}

export async function getPortalSignatureRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<PortalSignatureView> {
  const { data } = await client.request<PortalSignatureView>({
    path: `${portalPath(organizationSlug)}/${encodeURIComponent(requestId)}`,
  });
  return data;
}

/** Mails a 6-digit code; 429 `rate_limited` within 60 s of the last one or past 5 an hour. */
export async function sendSignatureCode(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
): Promise<SignatureCodeSentView> {
  const { data } = await client.request<SignatureCodeSentView>({
    method: 'POST',
    path: `${portalPath(organizationSlug)}/${encodeURIComponent(requestId)}/code`,
  });
  return data;
}

export async function signSignatureRequest(
  client: ApiClient,
  organizationSlug: string,
  requestId: string,
  input: SignInput,
): Promise<PortalSignatureView> {
  const { data } = await client.request<PortalSignatureView>({
    method: 'POST',
    path: `${portalPath(organizationSlug)}/${encodeURIComponent(requestId)}/sign`,
    body: input,
  });
  return data;
}

/** What a refused signature or code request means for the screen. */
export type SignRefusal =
  | 'code_wrong'
  | 'code_expired'
  | 'code_locked'
  | 'code_missing'
  | 'already_signed'
  | 'expired'
  | 'cancelled'
  | 'document_changed'
  | 'rate_limited'
  | 'invalid'
  | 'not_found'
  | null;

const CODE_REASONS = ['code_wrong', 'code_expired', 'code_locked', 'code_missing'] as const;
const REQUEST_REASONS = ['already_signed', 'expired', 'cancelled', 'document_changed'] as const;

/** Reads the API's refusal details into one reason, or `null` for anything else (network, 500). */
export function signRefusal(error: unknown): SignRefusal {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'rate_limited') return 'rate_limited';
  if (error.code === 'not_found') return 'not_found';
  const detail = (field: string) => error.details.find((d) => d.field === field)?.message;
  if (error.code === 'conflict') {
    const reason = detail('request');
    return (REQUEST_REASONS as readonly string[]).includes(reason ?? '')
      ? (reason as SignRefusal)
      : null;
  }
  if (error.code === 'validation_failed') {
    const reason = detail('code');
    if ((CODE_REASONS as readonly string[]).includes(reason ?? '')) return reason as SignRefusal;
    return 'invalid';
  }
  return null;
}
