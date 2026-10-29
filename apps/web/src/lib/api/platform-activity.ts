import type { ApiClient } from './client';
import type { PlatformSupportSessionView } from './platform-support';

/**
 * Platform admin · Activity & access (platform-admin v2 · PA-09, SPEC §4 C1–C6, §5.5). Each view
 * is paired Exact with the API's (`apps/api/src/modules/platform-admin/activity/activity.service.ts`)
 * in `e2e/contracts/api-web-shapes.ts`.
 *
 * IPs and devices are `null` unless the admin holds `platform.activity.detail`.
 */

/** One org action (C1 row). */
export interface PlatformActionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorName: string | null;
  readonly effectiveActorUserId: string | null;
  readonly effectiveActorEmail: string | null;
  readonly effectiveActorName: string | null;
  readonly action: string;
  /** The action in plain words (`auditActionLabel`). */
  readonly actionLabel: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly result: 'allowed' | 'denied' | 'error';
  readonly correlationId: string;
  readonly supportSessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
}

/** The summary line over the filter (C1: "2,418 actions · 37 via support · 12 denied · 3 errors"). */
export interface PlatformActionTotalsView {
  readonly total: number;
  readonly viaSupport: number;
  readonly denied: number;
  readonly errors: number;
}

/** `GET /v1/platform/activity/actions` */
export interface PlatformActionsPageView {
  readonly actions: readonly PlatformActionView[];
  readonly totals: PlatformActionTotalsView;
  /** Pass back as `cursor` for the next page; `null` on the last one. */
  readonly nextCursor: string | null;
  /** IPs and devices are shown (the admin holds `platform.activity.detail`). */
  readonly showsOrigin: boolean;
}

/** One before → after field (C2). A redacted field carries no values. */
export interface PlatformActionChangeView {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly redacted: boolean;
}

/** Another event of the same request (C2 "Same request"). */
export interface PlatformRelatedActionView {
  readonly id: string;
  readonly action: string;
  readonly actionLabel: string;
  readonly result: 'allowed' | 'denied' | 'error';
  readonly occurredAt: string;
}

/** The Support session an event was taken in (C2 Who). */
export interface PlatformActionSupportSessionView {
  readonly id: string;
  readonly adminEmail: string;
  readonly reason: string | null;
  readonly startedAt: string;
}

/** `GET /v1/platform/activity/actions/:organizationId/:eventId` (C2). */
export interface PlatformActionDetailView {
  readonly action: PlatformActionView;
  /** The actor's role in this organization (`platform_support` for a support visit). */
  readonly actorRole: string | null;
  readonly supportSession: PlatformActionSupportSessionView | null;
  /** The safe metadata (ids and classifications only, `isSafeAuditMetadata`). */
  readonly metadata: Readonly<Record<string, string>>;
  /** Empty for older events, and for refusals (nothing changed). */
  readonly changes: readonly PlatformActionChangeView[];
  readonly sameCorrelation: readonly PlatformRelatedActionView[];
}

/** One sign-in attempt (C3 Sign-ins, `authentication_events`). */
export interface PlatformSignInView {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

export interface PlatformSignInsPageView {
  readonly signIns: readonly PlatformSignInView[];
  readonly nextCursor: string | null;
}

/** One browser session platform-wide (C3 Live sessions). */
export interface PlatformLiveSessionView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly isPlatformAdmin: boolean;
  readonly userAgent: string | null;
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
}

export interface PlatformLiveSessionsPageView {
  readonly sessions: readonly PlatformLiveSessionView[];
  readonly nextCursor: string | null;
}

/** `DELETE /v1/platform/activity/access/sessions/:sessionId` */
export interface PlatformSessionEndedView {
  readonly ended: true;
  readonly userId: string;
}

/** One step-up: a platform admin's confirmation, or a member's re-authentication. */
export interface PlatformStepUpView {
  readonly id: string;
  readonly kind: 'platform' | 'member';
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly outcome: string;
  readonly mfaVerified: boolean;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
  readonly expiresAt: string | null;
}

export interface PlatformStepUpsPageView {
  readonly stepUps: readonly PlatformStepUpView[];
  readonly nextCursor: string | null;
}

/** One unusual pattern (C3 Suspicious). */
export interface PlatformSuspiciousPatternView {
  readonly kind: 'ip_burst' | 'repeated_failures';
  /** The IP (burst) or the account's email / id (repeated failures). */
  readonly source: string;
  readonly userId: string | null;
  readonly accountsHit: number;
  readonly failures: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly status: 'open' | 'locked';
}

/** `GET /v1/platform/activity/access/suspicious?window=` */
export interface PlatformSuspiciousView {
  readonly window: '1h' | '24h' | '7d';
  readonly patterns: readonly PlatformSuspiciousPatternView[];
  /** Sign-in from a new country needs a location lookup that is not switched on yet. */
  readonly geoAvailable: boolean;
}

/** One platform admin action (C4, `platform_admin_audit_events`). */
export interface PlatformAdminActionView {
  readonly id: string;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly reason: string | null;
  readonly supportSessionId: string | null;
  readonly correlationId: string;
  /** Redacted JSON, `null` without `platform.activity.detail`. */
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
}

export interface PlatformAdminActionsPageView {
  readonly actions: readonly PlatformAdminActionView[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export type PlatformExportScope =
  'actions' | 'sign-ins' | 'sessions' | 'platform' | 'orgs' | 'people';

export type PlatformExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

/** One CSV export (C6). */
export interface PlatformExportJobView {
  readonly id: string;
  readonly scope: PlatformExportScope;
  readonly filter: Readonly<Record<string, string>>;
  readonly status: PlatformExportStatus;
  readonly requestedByUserId: string;
  readonly requestedByEmail: string;
  readonly requestedByName: string;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
}

export interface PlatformExportJobsView {
  readonly exports: readonly PlatformExportJobView[];
}

/** `GET /v1/platform/activity/support-sessions` (C5): every visit, open ones first. */
export interface PlatformActivitySupportSessionsView {
  readonly sessions: readonly PlatformSupportSessionView[];
  readonly openCount: number;
}

/** A filter as query parameters: empty values are left out. */
export type ActivityQuery = Readonly<Record<string, string | undefined>>;

export const EXPORT_SCOPES: readonly PlatformExportScope[] = [
  'actions',
  'sign-ins',
  'sessions',
  'platform',
  'orgs',
  'people',
];

function query(params: ActivityQuery, cursor?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  if (cursor) out['cursor'] = cursor;
  return out;
}

async function get<T>(client: ApiClient, path: string, params: Record<string, string>): Promise<T> {
  const search = new URLSearchParams(params).toString();
  const { data } = await client.request<T>({
    method: 'GET',
    path: search === '' ? path : `${path}?${search}`,
  });
  return data;
}

const BASE = '/v1/platform/activity';

export function listPlatformActions(
  client: ApiClient,
  filter: ActivityQuery,
  cursor?: string | null,
): Promise<PlatformActionsPageView> {
  return get(client, `${BASE}/actions`, query(filter, cursor));
}

export function fetchPlatformActionDetail(
  client: ApiClient,
  organizationId: string,
  eventId: string,
): Promise<PlatformActionDetailView> {
  return get(
    client,
    `${BASE}/actions/${encodeURIComponent(organizationId)}/${encodeURIComponent(eventId)}`,
    {},
  );
}

export function listPlatformSignIns(
  client: ApiClient,
  filter: ActivityQuery,
  cursor?: string | null,
): Promise<PlatformSignInsPageView> {
  return get(client, `${BASE}/access/sign-ins`, query(filter, cursor));
}

export function listPlatformLiveSessions(
  client: ApiClient,
  filter: ActivityQuery,
  cursor?: string | null,
): Promise<PlatformLiveSessionsPageView> {
  return get(client, `${BASE}/access/sessions`, query(filter, cursor));
}

export async function endPlatformSession(
  client: ApiClient,
  sessionId: string,
  reason: string,
): Promise<PlatformSessionEndedView> {
  const { data } = await client.request<PlatformSessionEndedView>({
    method: 'DELETE',
    path: `${BASE}/access/sessions/${encodeURIComponent(sessionId)}`,
    body: { reason },
  });
  return data;
}

export function listPlatformStepUps(
  client: ApiClient,
  filter: ActivityQuery,
  cursor?: string | null,
): Promise<PlatformStepUpsPageView> {
  return get(client, `${BASE}/access/step-ups`, query(filter, cursor));
}

export function fetchPlatformSuspicious(
  client: ApiClient,
  window: PlatformSuspiciousView['window'],
): Promise<PlatformSuspiciousView> {
  return get(client, `${BASE}/access/suspicious`, { window });
}

export function listPlatformAdminActions(
  client: ApiClient,
  filter: ActivityQuery,
  cursor?: string | null,
): Promise<PlatformAdminActionsPageView> {
  return get(client, `${BASE}/platform`, query(filter, cursor));
}

export function listActivitySupportSessions(
  client: ApiClient,
  filter: ActivityQuery,
): Promise<PlatformActivitySupportSessionsView> {
  return get(client, `${BASE}/support-sessions`, query(filter));
}

export async function requestPlatformExport(
  client: ApiClient,
  input: {
    readonly scope: PlatformExportScope;
    readonly filter: ActivityQuery;
    readonly reason: string | null;
  },
): Promise<PlatformExportJobView> {
  const { data } = await client.request<PlatformExportJobView>({
    method: 'POST',
    path: `${BASE}/exports`,
    body: {
      scope: input.scope,
      filter: query(input.filter),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  return data;
}

export function listPlatformExports(client: ApiClient): Promise<PlatformExportJobsView> {
  return get(client, `${BASE}/exports`, {});
}

export async function deletePlatformExport(
  client: ApiClient,
  jobId: string,
  reason: string | null,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${BASE}/exports/${encodeURIComponent(jobId)}`,
    body: reason ? { reason } : {},
  });
}

/**
 * The download path; the screen prefixes `apiBaseUrl()`, and the API streams the CSV with the
 * session cookie.
 */
export function platformExportDownloadPath(jobId: string): string {
  return `${BASE}/exports/${encodeURIComponent(jobId)}/download`;
}
