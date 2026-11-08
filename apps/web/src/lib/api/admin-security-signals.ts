import type { ApiClient } from './client';

/**
 * 56-23 · Security signals, owner screen (R44 L2). Wraps
 * `GET /v1/organizations/:orgSlug/admin/security/events?kind&from&reviewed` (`audit.read`) and
 * `POST .../events/:signalId/reviewed` (`org.security.manage`, write-once). Platform rows never
 * reach an organization. {@link SecuritySignalView} mirrors the API's `SignalView`.
 */
export interface SecuritySignalView {
  readonly id: string;
  readonly organizationId: string | null;
  readonly ruleKey: string;
  readonly label: { readonly en: string; readonly ar: string };
  readonly severity: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly hasSource: boolean;
  readonly count: number;
  readonly windowStart: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly notifyStatus: string;
  readonly reviewedAt: string | null;
}

export interface SecuritySignalPage {
  readonly events: readonly SecuritySignalView[];
  readonly nextCursor: string | null;
}

/** The organization-scope rule keys an owner can filter on (`signal-rules.ts`, scope organization). */
export const ORGANIZATION_SIGNAL_KINDS = [
  'permission_churn',
  'mass_export',
  'invitation_burst',
  'public_link_guessing',
  'audit_chain_break',
  'support_session_long',
  'webhook_breaker',
] as const;

export type ReviewFilter = 'open' | 'all';
export type PeriodFilter = '7d' | '30d' | 'all';

export interface SignalFilters {
  readonly review: ReviewFilter;
  readonly kind: string | null;
  readonly period: PeriodFilter;
}

const DAY_MS = 86_400_000;

/** The query string for one filter state; `now` is injected so a test can pin the clock. */
export function signalQuery(filters: SignalFilters, now: Date): string {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.review === 'open') params.set('reviewed', 'false');
  if (filters.period !== 'all') {
    const days = filters.period === '7d' ? 7 : 30;
    params.set('from', new Date(now.getTime() - days * DAY_MS).toISOString());
  }
  params.set('limit', '100');
  return params.toString();
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/security/events`;
}

export async function listSecuritySignals(
  client: ApiClient,
  organizationSlug: string,
  filters: SignalFilters,
  now: Date = new Date(),
): Promise<SecuritySignalPage> {
  const { data } = await client.request<SecuritySignalPage>({
    path: `${base(organizationSlug)}?${signalQuery(filters, now)}`,
  });
  return data;
}

export async function markSignalReviewed(
  client: ApiClient,
  organizationSlug: string,
  signalId: string,
): Promise<SecuritySignalView> {
  const { data } = await client.request<SecuritySignalView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(signalId)}/reviewed`,
  });
  return data;
}
