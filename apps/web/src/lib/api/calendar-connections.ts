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
}

/** `GET …/integrations/google-calendar`. Paired `Exact` with the API's view. */
export interface CalendarConnectionStatusView {
  /** False when no Google client is set in the environment: the feature is off. */
  readonly configured: boolean;
  readonly google: CalendarAccountShape;
}

/** `GET …/integrations/microsoft-calendar` (slice B, same shape keyed `microsoft`). */
export interface MicrosoftCalendarStatusView {
  readonly configured: boolean;
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
