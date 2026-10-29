import type { ApiClient } from './client';

/**
 * Support mode (platform-admin v2 · PA-05, SPEC §5.2 "Support"). Each view is paired Exact with
 * the API's in `e2e/contracts/api-web-shapes.ts`.
 */

/** `POST /v1/platform/organizations/:id/support-session` */
export interface StartSupportSessionView {
  readonly id: string;
  readonly slug: string;
  readonly expiresAt: string;
  readonly redirectTo: string;
}

/** One support visit (C5 rows, the banner, the exit dialog). */
export interface PlatformSupportSessionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly reason: string | null;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly endedReason: string | null;
  readonly actionsCount: number;
  readonly live: boolean;
}

export interface PlatformSupportSessionsView {
  readonly sessions: readonly PlatformSupportSessionView[];
}

export interface PlatformSupportSessionDetailView {
  readonly session: PlatformSupportSessionView;
  readonly recentActions: readonly string[];
}

/** The lengths the enter dialog offers (435:14175): 30 min, 2 h (default), 8 h. */
export const SUPPORT_DURATIONS = [30, 120, 480] as const;
export const SUPPORT_DEFAULT_MINUTES = 120;
export const SUPPORT_EXTEND_MINUTES = 30;
/** Under this, the banner turns amber and offers "Extend 30 min" (437:18480). */
export const SUPPORT_WARNING_SECONDS = 5 * 60;

export async function startSupportSession(
  client: ApiClient,
  organizationId: string,
  input: { readonly minutes: number; readonly reason: string | null },
): Promise<StartSupportSessionView> {
  const { data } = await client.request<StartSupportSessionView>({
    method: 'POST',
    path: `/v1/platform/organizations/${encodeURIComponent(organizationId)}/support-session`,
    body: input.reason
      ? { minutes: input.minutes, reason: input.reason }
      : { minutes: input.minutes },
  });
  return data;
}

export async function listSupportSessions(
  client: ApiClient,
  filter: {
    readonly state?: 'open' | 'all';
    readonly adminId?: string;
    readonly organizationId?: string;
  } = {},
): Promise<PlatformSupportSessionsView> {
  const params = new URLSearchParams();
  if (filter.state === 'all') params.set('all', '1');
  if (filter.adminId) params.set('adminId', filter.adminId);
  if (filter.organizationId) params.set('organizationId', filter.organizationId);
  const query = params.toString();
  const { data } = await client.request<PlatformSupportSessionsView>({
    path: `/v1/platform/support-sessions${query === '' ? '' : `?${query}`}`,
  });
  return data;
}

export async function fetchSupportSession(
  client: ApiClient,
  sessionId: string,
): Promise<PlatformSupportSessionDetailView> {
  const { data } = await client.request<PlatformSupportSessionDetailView>({
    path: `/v1/platform/support-sessions/${encodeURIComponent(sessionId)}`,
  });
  return data;
}

export async function extendSupportSession(
  client: ApiClient,
  sessionId: string,
  minutes: number = SUPPORT_EXTEND_MINUTES,
): Promise<PlatformSupportSessionDetailView> {
  const { data } = await client.request<PlatformSupportSessionDetailView>({
    method: 'POST',
    path: `/v1/platform/support-sessions/${encodeURIComponent(sessionId)}/extend`,
    body: { minutes },
  });
  return data;
}

export async function endSupportSession(
  client: ApiClient,
  sessionId: string,
  reason: string | null = null,
): Promise<PlatformSupportSessionDetailView> {
  const { data } = await client.request<PlatformSupportSessionDetailView>({
    method: 'DELETE',
    path: `/v1/platform/support-sessions/${encodeURIComponent(sessionId)}`,
    body: reason ? { reason } : {},
  });
  return data;
}

/** C1 filtered to one session — "View my actions in this session". */
export function supportSessionActivityHref(sessionId: string): string {
  return `/platform/activity?supportSessionId=${encodeURIComponent(sessionId)}`;
}
