import type { ApiClient } from './client';

/** R7 presence (F4): online / last seen, and the caller's "show last seen" privacy toggle. */

export interface PresenceView {
  readonly userId: string;
  readonly online: boolean;
  /** ISO-8601, or null when never seen here or hidden by that person. */
  readonly lastSeenAt: string | null;
}

export interface PrivacyPreferencesView {
  readonly showLastSeen: boolean;
}

const base = (organizationSlug: string): string =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}`;

export async function sendPresenceHeartbeat(
  client: ApiClient,
  organizationSlug: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${base(organizationSlug)}/presence/heartbeat`,
  });
}

export async function getPresence(
  client: ApiClient,
  organizationSlug: string,
  userIds: readonly string[],
): Promise<readonly PresenceView[]> {
  if (userIds.length === 0) return [];
  const { data } = await client.request<{ people: readonly PresenceView[] }>({
    path: `${base(organizationSlug)}/presence?userIds=${encodeURIComponent(userIds.join(','))}`,
  });
  return data.people;
}

export async function getPrivacyPreferences(
  client: ApiClient,
  organizationSlug: string,
): Promise<PrivacyPreferencesView> {
  const { data } = await client.request<PrivacyPreferencesView>({
    path: `${base(organizationSlug)}/me/privacy-preferences`,
  });
  return data;
}

export async function setPrivacyPreferences(
  client: ApiClient,
  organizationSlug: string,
  view: PrivacyPreferencesView,
): Promise<PrivacyPreferencesView> {
  const { data } = await client.request<PrivacyPreferencesView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/me/privacy-preferences`,
    body: view,
  });
  return data;
}
