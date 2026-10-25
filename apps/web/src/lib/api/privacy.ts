import type { ApiClient } from './client';

/**
 * D5 (Figma F5) — Privacy: data export and deletion requests.
 *
 * Two doors onto the same records: the owner's Control › Privacy page (`…/admin/privacy`) and every
 * member's own "My data" page (`…/me/privacy`). Every exported `…View` here is paired Exact with the
 * API's shape of the same name in the contracts gate. The archive itself is never fetched through the
 * app: the download is a plain link to the API, which answers with `Content-Disposition: attachment`.
 */

export type PrivacyExportState = 'preparing' | 'ready' | 'failed' | 'expired';

export interface PrivacyPersonView {
  readonly userId: string;
  readonly displayName: string;
}

export interface PrivacyExportView {
  readonly id: string;
  readonly kind: 'company' | 'member';
  readonly state: PrivacyExportState;
  readonly progressPercent: number;
  readonly sizeBytes: number | null;
  readonly scanStatus: 'clean' | 'not_scanned' | null;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string | null;
  readonly requestedBy: PrivacyPersonView;
  readonly subject: PrivacyPersonView | null;
}

export interface PrivacyDeletionView {
  readonly id: string;
  readonly kind: 'company' | 'account';
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly daysLeft: number;
  readonly requestedBy: PrivacyPersonView;
}

export interface PrivacyMemberOptionView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly role: string;
}

export interface PrivacyOverviewView {
  readonly organizationName: string;
  readonly memberCount: number;
  readonly gracePeriodDays: number;
  readonly linkDays: number;
  /** The company exports, newest first; the first is the current one. */
  readonly companyExports: readonly PrivacyExportView[];
  /** The latest member export per person, newest first. */
  readonly memberExports: readonly PrivacyExportView[];
  readonly members: readonly PrivacyMemberOptionView[];
  readonly deletion: PrivacyDeletionView | null;
}

export interface MyPrivacyView {
  readonly organizationName: string;
  readonly gracePeriodDays: number;
  readonly linkDays: number;
  readonly export: PrivacyExportView | null;
  readonly deletion: PrivacyDeletionView | null;
}

function org(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

function adminBase(organizationSlug: string): string {
  return `${org(organizationSlug)}/admin/privacy`;
}

function myBase(organizationSlug: string): string {
  return `${org(organizationSlug)}/me/privacy`;
}

// ── The owner's page ─────────────────────────────────────────────────────────────────────────────

export async function readPrivacyOverview(
  client: ApiClient,
  organizationSlug: string,
): Promise<PrivacyOverviewView> {
  const { data } = await client.request<PrivacyOverviewView>({ path: adminBase(organizationSlug) });
  return data;
}

/** Ask for a company export, or (with a membership) one member's personal data. */
export async function requestPrivacyExport(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly kind: 'company' } | { readonly kind: 'member'; readonly membershipId: string },
): Promise<PrivacyOverviewView> {
  const { data } = await client.request<PrivacyOverviewView>({
    method: 'POST',
    path: `${adminBase(organizationSlug)}/exports`,
    body: input,
  });
  return data;
}

/** Schedule the company's deletion; `confirmName` is the company name, typed. */
export async function requestCompanyDeletion(
  client: ApiClient,
  organizationSlug: string,
  confirmName: string,
): Promise<PrivacyOverviewView> {
  const { data } = await client.request<PrivacyOverviewView>({
    method: 'POST',
    path: `${adminBase(organizationSlug)}/deletion`,
    body: { confirmName },
  });
  return data;
}

export async function cancelCompanyDeletion(
  client: ApiClient,
  organizationSlug: string,
): Promise<PrivacyOverviewView> {
  const { data } = await client.request<PrivacyOverviewView>({
    method: 'POST',
    path: `${adminBase(organizationSlug)}/deletion/cancel`,
  });
  return data;
}

/** The owner's download link for one archive (company, or a member export they asked for). */
export function privacyExportDownloadUrl(
  baseUrl: string,
  organizationSlug: string,
  exportId: string,
): string {
  return `${baseUrl}${adminBase(organizationSlug)}/exports/${encodeURIComponent(exportId)}/download`;
}

// ── My data ──────────────────────────────────────────────────────────────────────────────────────

export async function readMyPrivacy(
  client: ApiClient,
  organizationSlug: string,
): Promise<MyPrivacyView> {
  const { data } = await client.request<MyPrivacyView>({ path: myBase(organizationSlug) });
  return data;
}

export async function requestMyExport(
  client: ApiClient,
  organizationSlug: string,
): Promise<MyPrivacyView> {
  const { data } = await client.request<MyPrivacyView>({
    method: 'POST',
    path: `${myBase(organizationSlug)}/exports`,
  });
  return data;
}

export async function requestMyDeletion(
  client: ApiClient,
  organizationSlug: string,
): Promise<MyPrivacyView> {
  const { data } = await client.request<MyPrivacyView>({
    method: 'POST',
    path: `${myBase(organizationSlug)}/deletion`,
  });
  return data;
}

export async function cancelMyDeletion(
  client: ApiClient,
  organizationSlug: string,
): Promise<MyPrivacyView> {
  const { data } = await client.request<MyPrivacyView>({
    method: 'POST',
    path: `${myBase(organizationSlug)}/deletion/cancel`,
  });
  return data;
}

/** The member's own download link. */
export function myExportDownloadUrl(
  baseUrl: string,
  organizationSlug: string,
  exportId: string,
): string {
  return `${baseUrl}${myBase(organizationSlug)}/exports/${encodeURIComponent(exportId)}/download`;
}
