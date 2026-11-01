import type { ApiClient } from './client';
import type { SessionIntelView, SignInIntelView } from './session-intel';

/**
 * platform-admin v2 · PA-06 — People (`/v1/platform/people…`, SPEC §5.3, screens B1–B4).
 *
 * Reads need `platform.people.view`, the profile edit `platform.people.edit`, every security
 * action `platform.people.security`. Role changes and adding someone to an organization use
 * PA-07's member routes (`platform.people.roles`); overrides and "what can she do" are PA-04's.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired Exact with the API views in
 * `e2e/contracts/api-web-shapes.ts`.
 */

export interface PlatformPeopleOrgChipView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly audience: 'internal' | 'client';
  readonly role: string;
  readonly status: string;
}

export interface PlatformPeopleRowView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
  readonly mfaEnabled: boolean;
  readonly locale: string;
  readonly status: 'active' | 'disabled';
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly disabledByEmail: string | null;
  readonly liveSessions: number;
  /** Newest session refresh; within a few minutes means the person is using TManage now. */
  readonly lastActiveAt: string | null;
  readonly companies: readonly PlatformPeopleOrgChipView[];
}

export interface PlatformPeopleListView {
  readonly people: readonly PlatformPeopleRowView[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface PlatformPersonFactsView {
  readonly createdAt: string;
  readonly emailVerifiedAt: string | null;
  readonly lastSignInAt: string | null;
  readonly lastSignInDevice: string | null;
  readonly twoStepKind: string | null;
  readonly twoStepSetUpAt: string | null;
  readonly recoveryCodesLeft: number;
  readonly passwordSetAt: string | null;
  readonly personalAccessTokens: number;
  readonly aiAppGrants: number;
}

export interface PlatformPersonActionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly occurredAt: string;
  readonly viaSupport: boolean;
}

export interface PlatformPersonAccessView {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
  /** R12: where the attempt came from and how automated it looked. */
  readonly intel: SignInIntelView;
}

export interface PlatformPersonDetailView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly status: 'active' | 'disabled';
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly disabledByEmail: string | null;
  readonly twoStepRequired: boolean;
  readonly liveSessions: number;
  /** Newest session refresh; within a few minutes means the person is using TManage now. */
  readonly lastActiveAt: string | null;
  readonly facts: PlatformPersonFactsView;
  readonly companies: readonly PlatformPeopleOrgChipView[];
  readonly recentActions: readonly PlatformPersonActionView[];
  readonly recentAccess: readonly PlatformPersonAccessView[];
}

export interface PlatformPersonSessionView {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly state: 'live' | 'ended' | 'expired';
  /** R12: where the session came from. */
  readonly intel: SessionIntelView;
}

export interface PlatformPersonSessionsView {
  readonly sessions: readonly PlatformPersonSessionView[];
  readonly live: number;
  readonly endedRecently: number;
}

export interface PlatformPersonStepUpView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly mfaVerified: boolean;
}

export interface PlatformPersonAccessListView {
  readonly events: readonly PlatformPersonAccessView[];
  readonly stepUps: readonly PlatformPersonStepUpView[];
}

export interface PlatformPersonActionsView {
  readonly actions: readonly PlatformPersonActionView[];
  readonly nextCursor: string | null;
}

export interface PlatformPersonMembershipView {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly organizationStatus: 'active' | 'suspended' | 'archived';
  readonly audience: 'internal' | 'client';
  readonly role: string;
  /** The custom role's name when `role` is a custom role id; `null` for a built-in role. */
  readonly customRoleName: string | null;
  readonly status: string;
  readonly scope: 'org_wide' | 'assigned';
  readonly projects: number;
  readonly clientOrganizationName: string | null;
  readonly overridesAllow: number;
  readonly overridesDeny: number;
  readonly isOwner: boolean;
}

export interface PlatformPersonOrganizationsView {
  readonly memberships: readonly PlatformPersonMembershipView[];
}

export interface PlatformPersonSecurityResultView {
  readonly person: PlatformPersonDetailView;
  readonly sessionsEnded: number;
}

/** B1's filters. Every value optional; `undefined` and `''` leave a filter off. */
export interface PlatformPeopleQuery {
  readonly q?: string;
  readonly status?: 'active' | 'disabled' | 'any';
  readonly verified?: boolean;
  readonly mfa?: boolean;
  readonly locale?: string;
  readonly organizationId?: string;
  readonly role?: string;
  /** ISO day, e.g. 30 days ago for "Signed in: last 30 days". */
  readonly signInFrom?: string;
  readonly signInTo?: string;
  readonly hasSessions?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PlatformProfileChangeInput {
  readonly displayName?: string;
  readonly email?: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly reason?: string;
}

const BASE = '/v1/platform/people';

function person(userId: string): string {
  return `${BASE}/${encodeURIComponent(userId)}`;
}

/** The query string of B1's filters, in a stable order (the query key uses it too). */
export function peopleQueryString(filter: PlatformPeopleQuery): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === '') return;
    params.set(key, String(value));
  };
  put('q', filter.q?.trim());
  put('status', filter.status);
  put('verified', filter.verified);
  put('mfa', filter.mfa);
  put('locale', filter.locale);
  put('organizationId', filter.organizationId);
  put('role', filter.role);
  put('signInFrom', filter.signInFrom);
  put('signInTo', filter.signInTo);
  put('hasSessions', filter.hasSessions);
  put('cursor', filter.cursor);
  put('limit', filter.limit);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export async function listPlatformPeople(
  client: ApiClient,
  filter: PlatformPeopleQuery = {},
): Promise<PlatformPeopleListView> {
  const { data } = await client.request<PlatformPeopleListView>({
    path: `${BASE}${peopleQueryString(filter)}`,
  });
  return data;
}

export async function fetchPlatformPerson(
  client: ApiClient,
  userId: string,
): Promise<PlatformPersonDetailView> {
  const { data } = await client.request<PlatformPersonDetailView>({ path: person(userId) });
  return data;
}

export async function updatePlatformPerson(
  client: ApiClient,
  userId: string,
  change: PlatformProfileChangeInput,
): Promise<PlatformPersonDetailView> {
  const { data } = await client.request<PlatformPersonDetailView>({
    method: 'PATCH',
    path: person(userId),
    body: change,
  });
  return data;
}

export async function fetchPlatformPersonSessions(
  client: ApiClient,
  userId: string,
): Promise<PlatformPersonSessionsView> {
  const { data } = await client.request<PlatformPersonSessionsView>({
    path: `${person(userId)}/sessions`,
  });
  return data;
}

export async function endPlatformPersonSession(
  client: ApiClient,
  userId: string,
  sessionId: string,
  reason: string,
): Promise<{ readonly ended: boolean }> {
  const { data } = await client.request<{ readonly ended: boolean }>({
    method: 'DELETE',
    path: `${person(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    body: { reason },
  });
  return data;
}

export async function signOutPlatformPersonEverywhere(
  client: ApiClient,
  userId: string,
  reason: string,
): Promise<unknown> {
  const { data } = await client.request<unknown>({
    method: 'POST',
    path: `${person(userId)}/sign-out`,
    body: { reason },
  });
  return data;
}

export async function sendPlatformPersonPasswordReset(
  client: ApiClient,
  userId: string,
  reason: string,
): Promise<unknown> {
  const { data } = await client.request<unknown>({
    method: 'POST',
    path: `${person(userId)}/password-reset`,
    body: { reason },
  });
  return data;
}

export async function resetPlatformPersonTwoStep(
  client: ApiClient,
  userId: string,
  input: { readonly reason: string; readonly signOut: boolean },
): Promise<PlatformPersonSecurityResultView> {
  const { data } = await client.request<PlatformPersonSecurityResultView>({
    method: 'POST',
    path: `${person(userId)}/two-step/reset`,
    body: input,
  });
  return data;
}

export async function setPlatformPersonTwoStepRequired(
  client: ApiClient,
  userId: string,
  required: boolean,
  reason?: string,
): Promise<PlatformPersonDetailView> {
  const { data } = await client.request<PlatformPersonDetailView>({
    method: 'PUT',
    path: `${person(userId)}/two-step/required`,
    body: { required, ...(reason ? { reason } : {}) },
  });
  return data;
}

export async function disablePlatformPerson(
  client: ApiClient,
  userId: string,
  reason: string,
): Promise<PlatformPersonSecurityResultView> {
  const { data } = await client.request<PlatformPersonSecurityResultView>({
    method: 'POST',
    path: `${person(userId)}/disable`,
    body: { reason },
  });
  return data;
}

export async function enablePlatformPerson(
  client: ApiClient,
  userId: string,
  reason?: string | null,
): Promise<PlatformPersonDetailView> {
  const { data } = await client.request<PlatformPersonDetailView>({
    method: 'POST',
    path: `${person(userId)}/enable`,
    body: reason ? { reason } : {},
  });
  return data;
}

export async function fetchPlatformPersonOrganizations(
  client: ApiClient,
  userId: string,
): Promise<PlatformPersonOrganizationsView> {
  const { data } = await client.request<PlatformPersonOrganizationsView>({
    path: `${person(userId)}/organizations`,
  });
  return data;
}

export async function fetchPlatformPersonAccess(
  client: ApiClient,
  userId: string,
  range: { readonly from?: string; readonly to?: string; readonly outcome?: string } = {},
): Promise<PlatformPersonAccessListView> {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  if (range.outcome) params.set('outcome', range.outcome);
  const query = params.toString();
  const { data } = await client.request<PlatformPersonAccessListView>({
    path: `${person(userId)}/access${query ? `?${query}` : ''}`,
  });
  return data;
}

export async function fetchPlatformPersonActions(
  client: ApiClient,
  userId: string,
  cursor?: string | null,
): Promise<PlatformPersonActionsView> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const { data } = await client.request<PlatformPersonActionsView>({
    path: `${person(userId)}/actions${query}`,
  });
  return data;
}

// ── B4: PA-07's member routes (the role select, add to organization, offboard) ──────────────

function orgMembers(organizationId: string): string {
  return `/v1/platform/organizations/${encodeURIComponent(organizationId)}/members`;
}

/** Adds an existing TManage account to an organization directly (no invitation). */
export async function addPlatformPersonToOrganization(
  client: ApiClient,
  organizationId: string,
  input: { readonly email: string; readonly role: string; readonly reason?: string | null },
): Promise<unknown> {
  const { data } = await client.request<unknown>({
    method: 'POST',
    path: orgMembers(organizationId),
    body: {
      email: input.email,
      role: input.role,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  return data;
}

export async function changePlatformMemberRole(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
  role: string,
  reason?: string | null,
): Promise<unknown> {
  const { data } = await client.request<unknown>({
    method: 'PUT',
    path: `${orgMembers(organizationId)}/${encodeURIComponent(membershipId)}/role`,
    body: { role, ...(reason ? { reason } : {}) },
  });
  return data;
}

export async function offboardPlatformMember(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
  reason: string,
): Promise<unknown> {
  const { data } = await client.request<unknown>({
    method: 'POST',
    path: `${orgMembers(organizationId)}/${encodeURIComponent(membershipId)}/offboard`,
    body: { reason },
  });
  return data;
}

/** R12: the absolute URL of one person's sign-in trail CSV (behind `platform.people.security`). */
export function personSignInTrailCsvUrl(baseUrl: string, userId: string): string {
  return `${baseUrl}/v1/platform/people/${encodeURIComponent(userId)}/sign-in-trail.csv`;
}
