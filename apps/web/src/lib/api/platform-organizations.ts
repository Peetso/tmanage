import type { ApiClient } from './client';

/**
 * Platform admin · Organizations (`/v1/platform/{overview,search,organizations…}`, SPEC §6,
 * PA-07). Reads need `platform.orgs.view`; edits `platform.orgs.edit`; members and roles
 * `platform.people.roles`; lifecycle acts `platform.orgs.lifecycle` (purge: super admin only).
 * Plan/billing mode, storage disconnect, offboarding and every lifecycle act need a reason.
 *
 * Paired with the API views in `e2e/contracts/api-web-shapes.ts`.
 */

export type PlatformOrgStatus = 'active' | 'suspended' | 'deleted' | 'archived';
export type PlatformOrgHealth = 'good' | 'check' | 'failing';

export interface PlatformOrgSummaryView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string | null;
  readonly people: number;
  readonly clients: number;
  readonly projects: number;
  readonly plan: string | null;
  readonly storageBytes: number;
  readonly storageLimitBytes: number;
  readonly peopleLimit: number | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly status: PlatformOrgStatus;
  readonly health: PlatformOrgHealth;
  readonly failedRuns7d: number;
  readonly suspendedAt: string | null;
  readonly deletedAt: string | null;
  readonly purgeAfter: string | null;
}

export interface PlatformOrgCountsView {
  readonly all: number;
  readonly active: number;
  readonly suspended: number;
  readonly deleted: number;
  readonly archived: number;
}

export interface PlatformOrgListView {
  readonly organizations: readonly PlatformOrgSummaryView[];
  readonly nextCursor: string | null;
  readonly counts: PlatformOrgCountsView;
  readonly openSupportSessions: number;
}

export interface PlatformOrgAttentionView {
  readonly organizationId: string;
  readonly name: string;
  readonly kind: 'failing' | 'storage' | 'people' | 'purge';
  readonly level: 'check' | 'action';
  readonly detail: string;
}

export interface PlatformOrgActionView {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
}

export interface PlatformOrgOverviewView {
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
  readonly deletedInWindow: number;
  readonly firstPurgeAt: string | null;
  readonly openSupportSessions: number;
  readonly firstSupportExpiry: string | null;
  readonly attention: readonly PlatformOrgAttentionView[];
  readonly recentActions: readonly PlatformOrgActionView[];
}

export interface PlatformOrgSearchView {
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly people: readonly {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
  }[];
}

export interface PlatformOrgAuditView {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly actorEmail: string | null;
  readonly occurredAt: string;
}

export interface PlatformOrgDetailView {
  readonly organization: PlatformOrgSummaryView;
  readonly profile: {
    readonly defaultLocale: string;
    readonly timezone: string;
    readonly operatorNotes: string | null;
    readonly billingModeOverride: 'beta_free' | 'paid' | null;
  };
  readonly counts: {
    readonly invited: number;
    readonly openApprovals: number;
  };
  readonly integrations: readonly string[];
  readonly admins: readonly {
    readonly membershipId: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: string;
  }[];
  readonly supportSessions: readonly {
    readonly id: string;
    readonly adminName: string | null;
    readonly adminEmail: string | null;
    readonly startedAt: string;
    readonly expiresAt: string;
    readonly reason: string | null;
    readonly actionsCount: number;
  }[];
  readonly audit: readonly PlatformOrgAuditView[];
  readonly platformActions: readonly PlatformOrgActionView[];
  readonly restoreDaysLeft: number | null;
  readonly retentionDays: number;
}

export interface PlatformOrgWriteView {
  readonly organization: PlatformOrgSummaryView;
}

export interface PlatformOrgLimitView {
  readonly plan: number | null;
  readonly override: number | null;
  readonly usage: number;
}

export interface PlatformOrgPlanView {
  readonly planId: string;
  readonly plans: readonly string[];
  readonly platformMode: 'beta_free' | 'paid';
  readonly override: 'inherit' | 'beta_free' | 'paid';
  readonly effectiveMode: 'beta_free' | 'paid';
  readonly subscription: {
    readonly status: string;
    readonly currentPeriodEnd: string | null;
  } | null;
  readonly limits: {
    readonly people: PlatformOrgLimitView;
    readonly activeProjects: PlatformOrgLimitView;
    readonly storageBytes: PlatformOrgLimitView;
  };
}

export interface PlatformOrgStorageView {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly connections: readonly {
    readonly id: string;
    readonly provider: string;
    readonly status: string;
    readonly accountEmail: string | null;
    readonly location: string | null;
    readonly connectedByEmail: string | null;
    readonly lastSyncAt: string | null;
  }[];
}

export interface PlatformOrgDeletedView {
  readonly organizations: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly deletedByEmail: string | null;
    readonly deletedAt: string;
    readonly purgeAfter: string | null;
    readonly daysLeft: number;
    readonly storageBytes: number;
  }[];
  readonly retentionDays: number;
}

export interface PlatformOrgSettingView {
  readonly key: string;
  readonly value: string;
  readonly isDefault: boolean;
  readonly ownerOnly: boolean;
  readonly updatedAt: string | null;
}

export interface PlatformOrgFlagView {
  readonly key: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly platformDefault: boolean;
}

export interface PlatformOrgSettingsView {
  readonly settings: readonly PlatformOrgSettingView[];
  readonly policy: {
    readonly session_max_hours: number;
    readonly invite_domain_allowlist: readonly string[];
    readonly guest_access_enabled: boolean;
  };
  readonly flags: readonly PlatformOrgFlagView[];
  readonly hasLogo: boolean;
}

export interface PlatformOrgMemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly lastSignInAt: string | null;
  readonly mfaEnabled: boolean;
  readonly overrides: number;
}

export interface PlatformOrgMembersView {
  readonly internal: readonly PlatformOrgMemberView[];
  readonly clients: readonly {
    readonly membershipId: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: string;
    readonly status: string;
    readonly clientName: string | null;
  }[];
  readonly invitations: readonly {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly invitedByEmail: string | null;
  }[];
  readonly roles: readonly string[];
}

export interface PlatformOrgMemberWriteView {
  readonly member: PlatformOrgMemberView;
}

export interface PlatformOrgListQuery {
  readonly q?: string;
  readonly status?: string;
  readonly plan?: string;
  readonly health?: string;
  readonly createdFrom?: string;
  readonly activeFrom?: string;
  readonly cursor?: string;
}

const BASE = '/v1/platform';

function org(id: string, rest = ''): string {
  return `${BASE}/organizations/${encodeURIComponent(id)}${rest}`;
}

async function get<T>(client: ApiClient, path: string): Promise<T> {
  const { data } = await client.request<T>({ path });
  return data;
}

async function send<T>(
  client: ApiClient,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { data } = await client.request<T>({
    method,
    path,
    ...(body === undefined ? {} : { body }),
  });
  return data;
}

export function fetchPlatformOrgOverview(client: ApiClient) {
  return get<PlatformOrgOverviewView>(client, `${BASE}/overview`);
}

export function searchPlatform(client: ApiClient, q: string) {
  return get<PlatformOrgSearchView>(client, `${BASE}/search?q=${encodeURIComponent(q)}`);
}

export function listPlatformOrgs(client: ApiClient, filters: PlatformOrgListQuery = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value !== '') query.set(key, value);
  }
  const suffix = query.toString();
  return get<PlatformOrgListView>(client, `${BASE}/organizations${suffix ? `?${suffix}` : ''}`);
}

export function createPlatformOrg(
  client: ApiClient,
  input: { name: string; slug: string; ownerEmail: string; plan?: string; reason?: string },
) {
  return send<PlatformOrgWriteView>(client, 'POST', `${BASE}/organizations`, input);
}

export function fetchDeletedPlatformOrgs(client: ApiClient) {
  return get<PlatformOrgDeletedView>(client, `${BASE}/organizations/deleted`);
}

export function fetchPlatformOrg(client: ApiClient, id: string) {
  return get<PlatformOrgDetailView>(client, org(id));
}

export function updatePlatformOrgProfile(
  client: ApiClient,
  id: string,
  input: {
    name?: string;
    slug?: string;
    defaultLocale?: string;
    timezone?: string;
    operatorNotes?: string | null;
    reason?: string;
  },
) {
  return send<PlatformOrgWriteView>(client, 'PATCH', org(id, '/profile'), input);
}

export function removePlatformOrgLogo(client: ApiClient, id: string) {
  return send<PlatformOrgWriteView>(client, 'DELETE', org(id, '/logo'));
}

export function fetchPlatformOrgSettings(client: ApiClient, id: string) {
  return get<PlatformOrgSettingsView>(client, org(id, '/settings'));
}

export function setPlatformOrgSetting(client: ApiClient, id: string, key: string, value: string) {
  return send<PlatformOrgSettingsView>(
    client,
    'PUT',
    org(id, `/settings/${encodeURIComponent(key)}`),
    {
      value,
    },
  );
}

export function setPlatformOrgPolicy(
  client: ApiClient,
  id: string,
  patch: Record<string, unknown>,
) {
  return send<PlatformOrgSettingsView>(client, 'PUT', org(id, '/policies'), patch);
}

export function setPlatformOrgFlag(
  client: ApiClient,
  id: string,
  flagKey: string,
  enabled: boolean | null,
) {
  return send<PlatformOrgSettingsView>(
    client,
    'PUT',
    org(id, `/flags/${encodeURIComponent(flagKey)}`),
    {
      enabled,
    },
  );
}

export function fetchPlatformOrgPlan(client: ApiClient, id: string) {
  return get<PlatformOrgPlanView>(client, org(id, '/plan'));
}

export function setPlatformOrgPlan(
  client: ApiClient,
  id: string,
  input: { planId?: string; billingModeOverride: 'inherit' | 'beta_free' | 'paid'; reason: string },
) {
  return send<PlatformOrgPlanView>(client, 'PUT', org(id, '/plan'), input);
}

export function setPlatformOrgLimits(
  client: ApiClient,
  id: string,
  input: { people: number | null; activeProjects: number | null; storageBytes: number | null },
) {
  return send<PlatformOrgPlanView>(client, 'PUT', org(id, '/limits'), input);
}

export function fetchPlatformOrgStorage(client: ApiClient, id: string) {
  return get<PlatformOrgStorageView>(client, org(id, '/storage'));
}

export function recountPlatformOrgStorage(client: ApiClient, id: string) {
  return send<PlatformOrgStorageView>(client, 'POST', org(id, '/storage/recount'), {});
}

export function disconnectPlatformOrgStorage(
  client: ApiClient,
  id: string,
  connectionId: string,
  reason: string,
) {
  return send<PlatformOrgStorageView>(
    client,
    'DELETE',
    org(id, `/storage/connections/${encodeURIComponent(connectionId)}`),
    { reason },
  );
}

export function fetchPlatformOrgMembers(client: ApiClient, id: string) {
  return get<PlatformOrgMembersView>(client, org(id, '/members'));
}

export function changePlatformOrgMemberRole(
  client: ApiClient,
  id: string,
  membershipId: string,
  role: string,
  reason?: string | null,
) {
  return send<PlatformOrgMemberWriteView>(
    client,
    'PUT',
    org(id, `/members/${encodeURIComponent(membershipId)}/role`),
    { role, ...(reason ? { reason } : {}) },
  );
}

export function addPlatformOrgMember(client: ApiClient, id: string, email: string, role: string) {
  return send<PlatformOrgMemberWriteView>(client, 'POST', org(id, '/members'), { email, role });
}

export function offboardPlatformOrgMember(
  client: ApiClient,
  id: string,
  membershipId: string,
  reason: string,
) {
  return send<{ offboardedMembershipId: string }>(
    client,
    'POST',
    org(id, `/members/${encodeURIComponent(membershipId)}/offboard`),
    { reason },
  );
}

export function revokePlatformOrgInvitation(client: ApiClient, id: string, invitationId: string) {
  return send<{ revokedInvitationId: string }>(
    client,
    'POST',
    org(id, `/invitations/${encodeURIComponent(invitationId)}/revoke`),
    {},
  );
}

export type PlatformOrgLifecycleAct =
  | 'suspension'
  | 'reactivation'
  | 'deletion'
  | 'restore'
  | 'purge'
  | 'archive'
  | 'unarchive'
  | 'policy-refresh'
  | 'ownership-transfer';

export function runPlatformOrgLifecycle(
  client: ApiClient,
  id: string,
  act: PlatformOrgLifecycleAct,
  body: { reason: string; confirmSlug?: string; newOwnerMembershipId?: string },
) {
  return send<PlatformOrgWriteView>(client, 'POST', org(id, `/${act}`), body);
}
