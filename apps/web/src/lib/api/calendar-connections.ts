import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * 0237. Each person's own calendar connection (Settings > Calendar connections). Meetings a
 * person organizes are sent from their own Google or Microsoft calendar, so the connection is
 * per person, not the company Drive connection. Google is slice A; Microsoft (slice B) uses the
 * same route shapes under `integrations/microsoft-calendar` and is hidden while its status
 * endpoint is missing or says it is not configured.
 */

type ConnectionState = 'not_connected' | 'connected' | 'error';

/** One provider's side of a person's connection. */
interface CalendarAccountShape {
  readonly status: ConnectionState;
  /** The caller's own address at the provider (this view is only ever the caller's own). */
  readonly accountEmail: string | null;
  readonly connectedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode: string | null;
  /** 53-14: when the last failed sync happened (`lastErrorCode` says what failed). */
  readonly lastErrorAt: string | null;
  /** 53-14: when instant updates end unless renewed; `null` while polled each minute. */
  readonly pushExpiresAt: string | null;
  /** 53-14: the person's own due dates shown in this calendar. */
  readonly mirrorDueDates: boolean;
}

/** `GET …/integrations/google-calendar`. Paired `Exact` with the API's view. */
export interface CalendarConnectionStatusView {
  /** False when no Google client is set in the environment: the feature is off. */
  readonly configured: boolean;
  /** PAUSED-FLAG: present on the status read while the platform has switched the service off. */
  readonly paused?: true;
  readonly google: CalendarAccountShape;
}

/** `GET …/integrations/microsoft-calendar` (slice B, same shape keyed `microsoft`). */
export interface MicrosoftCalendarStatusView {
  readonly configured: boolean;
  /** PAUSED-FLAG: present on the status read while the platform has switched the service off. */
  readonly paused?: true;
  readonly microsoft: CalendarAccountShape;
}

/** `GET …/integrations/google-calendar/team` (owners): who has which calendar connected. */
export interface CalendarTeamView {
  readonly connections: readonly {
    readonly userId: string;
    readonly provider: string;
    readonly status: string;
  }[];
}

export type CalendarProviderId = 'google' | 'microsoft';

function integrationPath(organizationSlug: string, provider: CalendarProviderId): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/integrations/${provider}-calendar`;
}

export async function getGoogleCalendarStatus(
  client: ApiClient,
  organizationSlug: string,
): Promise<CalendarConnectionStatusView> {
  const { data } = await client.request<CalendarConnectionStatusView>({
    path: integrationPath(organizationSlug, 'google'),
  });
  return data;
}

/**
 * Microsoft's status, or `null` while the Microsoft calendar backend is not deployed (404/501) —
 * the screens then show no Microsoft option at all.
 */
export async function getMicrosoftCalendarStatus(
  client: ApiClient,
  organizationSlug: string,
): Promise<MicrosoftCalendarStatusView | null> {
  try {
    const { data } = await client.request<MicrosoftCalendarStatusView>({
      path: integrationPath(organizationSlug, 'microsoft'),
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 501)) {
      return null;
    }
    throw error;
  }
}

/** Start connecting; the browser then goes to the provider's consent screen at `url`. */
export async function startCalendarConnect(
  client: ApiClient,
  organizationSlug: string,
  provider: CalendarProviderId,
): Promise<{ readonly url: string }> {
  const { data } = await client.request<{ readonly url: string }>({
    method: 'POST',
    path: `${integrationPath(organizationSlug, provider)}/connect`,
    body: {},
  });
  return data;
}

/** Finish connecting with the code and state the callback forwarded in the fragment. */
export async function completeCalendarConnect(
  client: ApiClient,
  organizationSlug: string,
  provider: CalendarProviderId,
  input: { readonly code: string; readonly state: string },
): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${integrationPath(organizationSlug, provider)}/complete`,
    body: input,
  });
}

/** Disconnect the caller's own calendar (the provider is asked to revoke the grant). */
export async function disconnectCalendar(
  client: ApiClient,
  organizationSlug: string,
  provider: CalendarProviderId,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: integrationPath(organizationSlug, provider),
  });
}

/** Owners only: every person's calendar connection, for "Your team's calendars". */
export async function getCalendarTeam(
  client: ApiClient,
  organizationSlug: string,
): Promise<CalendarTeamView> {
  const { data } = await client.request<CalendarTeamView>({
    path: `${integrationPath(organizationSlug, 'google')}/team`,
  });
  return data;
}

/** 53-14. Turn the caller's due-date mirror on or off for one of their connected calendars. */
export async function setDueDateMirror(
  client: ApiClient,
  organizationSlug: string,
  provider: CalendarProviderId,
  enabled: boolean,
): Promise<void> {
  await client.request<unknown>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/calendar-sync/${provider}/due-date-mirror`,
    body: { enabled },
  });
}

/** `GET …/calendar-sync/feed`. Paired `Exact` with the API's view; never carries the address. */
export interface CalendarFeedView {
  readonly active: boolean;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
}

/** `POST …/calendar-sync/feed`: the new address, shown once. */
export interface CalendarFeedCreatedView extends CalendarFeedView {
  readonly url: string;
}

function feedPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/calendar-sync/feed`;
}

export async function getCalendarFeed(
  client: ApiClient,
  organizationSlug: string,
): Promise<CalendarFeedView> {
  const { data } = await client.request<CalendarFeedView>({ path: feedPath(organizationSlug) });
  return data;
}

/** Create the caller's feed address, or replace it (the old one stops working). */
export async function rotateCalendarFeed(
  client: ApiClient,
  organizationSlug: string,
): Promise<CalendarFeedCreatedView> {
  const { data } = await client.request<CalendarFeedCreatedView>({
    method: 'POST',
    path: feedPath(organizationSlug),
    body: {},
  });
  return data;
}

export async function revokeCalendarFeed(
  client: ApiClient,
  organizationSlug: string,
): Promise<CalendarFeedView> {
  const { data } = await client.request<CalendarFeedView>({
    method: 'DELETE',
    path: feedPath(organizationSlug),
  });
  return data;
}

/**
 * Read the fragment the API's callback forwards: `#gcal=complete&code&state` (Google) or
 * `#mscal=complete&code&state` (Microsoft), or `=error`. Pure, so the hand-over is provable.
 */
export function readCalendarReturn(
  hash: string,
):
  | { readonly kind: 'complete'; provider: CalendarProviderId; code: string; state: string }
  | { readonly kind: 'error'; provider: CalendarProviderId }
  | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const keys: readonly [string, CalendarProviderId][] = [
    ['gcal', 'google'],
    ['mscal', 'microsoft'],
  ];
  for (const [key, provider] of keys) {
    const value = params.get(key);
    if (value === 'error') return { kind: 'error', provider };
    const code = params.get('code');
    const state = params.get('state');
    if (value === 'complete' && code && state) return { kind: 'complete', provider, code, state };
  }
  return null;
}
