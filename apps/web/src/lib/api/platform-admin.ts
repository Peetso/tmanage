import type { ApiClient } from './client';

/**
 * Platform admin — the TManage operator's API (`/v1/platform/*`). Only people whose verified
 * email is in the server's `PLATFORM_ADMIN_EMAILS` get anything but a 404 here, and every
 * route except `me` and `step-up` also needs a password (and two-step code) confirmation from
 * the last 15 minutes, answered as 403 `reauthentication_required` when it has lapsed.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API views in
 * `e2e/contracts/api-web-shapes.ts`.
 */

export interface PlatformMeView {
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnabled: boolean;
  readonly stepUpExpiresAt: string | null;
  readonly stepUpMinutes: number;
}

export interface PlatformOverviewView {
  readonly companies: number;
  readonly suspendedCompanies: number;
  readonly people: number;
  readonly signups7d: number;
  readonly signups30d: number;
  readonly activeToday: number;
  readonly storageBytesUsed: number;
  readonly failedAutomationRuns7d: number;
  readonly outboxErrors: number;
  readonly computedAt: string;
}

export interface PlatformCompanyView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string | null;
  readonly people: number;
  readonly clients: number;
  readonly projects: number;
  readonly plan: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly status: 'active' | 'suspended' | 'archived';
  readonly suspendedAt: string | null;
}

export interface PlatformCompanyAuditView {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly occurredAt: string;
}

export interface PlatformCompanyDetailView {
  readonly company: PlatformCompanyView;
  readonly recentAdminEvents: readonly PlatformCompanyAuditView[];
}

export interface PlatformPersonView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
  readonly mfaEnabled: boolean;
  readonly companies: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly audience: 'internal' | 'client';
    readonly role: string;
    readonly status: string;
  }[];
}

export interface PlatformSettingsView {
  readonly publicSignup: {
    readonly open: boolean;
    readonly source: 'environment' | 'platform_setting';
    readonly environmentDefault: boolean;
  };
}

export interface PlatformAuditEventView {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly reason: string;
  readonly occurredAt: string;
}

export async function fetchPlatformMe(client: ApiClient): Promise<PlatformMeView> {
  const { data } = await client.request<PlatformMeView>({ path: '/v1/platform/me' });
  return data;
}

export async function stepUpPlatform(
  client: ApiClient,
  input: { readonly password: string; readonly code?: string },
): Promise<{ readonly expiresAt: string; readonly mfaVerified: boolean }> {
  const { data } = await client.request<{ expiresAt: string; mfaVerified: boolean }>({
    method: 'POST',
    path: '/v1/platform/step-up',
    body: input.code
      ? { password: input.password, code: input.code }
      : { password: input.password },
  });
  return data;
}

export async function fetchPlatformOverview(client: ApiClient): Promise<PlatformOverviewView> {
  const { data } = await client.request<PlatformOverviewView>({ path: '/v1/platform/overview' });
  return data;
}

export async function listPlatformCompanies(
  client: ApiClient,
  search = '',
): Promise<readonly PlatformCompanyView[]> {
  const query = search.trim() === '' ? '' : `?q=${encodeURIComponent(search.trim())}`;
  const { data } = await client.request<{ companies: readonly PlatformCompanyView[] }>({
    path: `/v1/platform/companies${query}`,
  });
  return data.companies;
}

export async function fetchPlatformCompany(
  client: ApiClient,
  organizationId: string,
): Promise<PlatformCompanyDetailView> {
  const { data } = await client.request<PlatformCompanyDetailView>({
    path: `/v1/platform/companies/${encodeURIComponent(organizationId)}`,
  });
  return data;
}

export async function setPlatformCompanySuspended(
  client: ApiClient,
  organizationId: string,
  suspend: boolean,
  reason: string,
): Promise<PlatformCompanyView> {
  const { data } = await client.request<{ company: PlatformCompanyView }>({
    method: 'POST',
    path: `/v1/platform/companies/${encodeURIComponent(organizationId)}/${suspend ? 'suspension' : 'reactivation'}`,
    body: { reason },
  });
  return data.company;
}

export async function searchPlatformPeople(
  client: ApiClient,
  email: string,
): Promise<readonly PlatformPersonView[]> {
  const { data } = await client.request<{ people: readonly PlatformPersonView[] }>({
    path: `/v1/platform/people?email=${encodeURIComponent(email.trim())}`,
  });
  return data.people;
}

export async function signOutPlatformPerson(
  client: ApiClient,
  userId: string,
  reason: string,
): Promise<{ readonly sessionsEnded: number }> {
  const { data } = await client.request<{ sessionsEnded: number }>({
    method: 'POST',
    path: `/v1/platform/people/${encodeURIComponent(userId)}/sign-out`,
    body: { reason },
  });
  return data;
}

export async function sendPlatformPasswordReset(
  client: ApiClient,
  userId: string,
  reason: string,
): Promise<void> {
  await client.request<{ status: 'sent' }>({
    method: 'POST',
    path: `/v1/platform/people/${encodeURIComponent(userId)}/password-reset`,
    body: { reason },
  });
}

export async function fetchPlatformSettings(client: ApiClient): Promise<PlatformSettingsView> {
  const { data } = await client.request<PlatformSettingsView>({ path: '/v1/platform/settings' });
  return data;
}

export async function setPlatformPublicSignup(
  client: ApiClient,
  open: boolean,
  reason: string,
): Promise<PlatformSettingsView> {
  const { data } = await client.request<PlatformSettingsView>({
    method: 'PUT',
    path: '/v1/platform/settings/public-signup',
    body: { open, reason },
  });
  return data;
}

export async function listPlatformAudit(
  client: ApiClient,
): Promise<readonly PlatformAuditEventView[]> {
  const { data } = await client.request<{ events: readonly PlatformAuditEventView[] }>({
    path: '/v1/platform/audit',
  });
  return data.events;
}
