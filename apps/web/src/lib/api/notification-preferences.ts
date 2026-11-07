import type { ApiClient } from './client';
import type { QuietHoursView } from './quiet-hours';

/**
 * NOTIF-001 notification preferences — the caller's own channel, digest and quiet-hours settings
 * (`GET/PUT .../notification-preferences`, behind `work.read`, the authenticated member's own row).
 *
 * This is the store the delivery worker reads to hold a notification back, so it is where a saved
 * quiet-hours window actually takes effect. The PREF-QUIET screen (`/preferences/quiet-hours`) keeps
 * its own copy with weekdays; {@link effectiveQuietHours} reads the two together so the form shows
 * the window that was saved, and {@link withQuietWindow} builds the PUT that keeps them in step.
 */

/** What the GET/PUT route exchanges. PUT is a full replacement, so every field is sent back. */
export interface NotificationPreferencesView {
  readonly inAppEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly digestFrequency: 'off' | 'daily' | 'weekly';
  /** `HH:MM:SS` (or `HH:MM`) in `quietHoursTimezone`, or null for no quiet hours. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly quietHoursTimezone: string | null;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/notification-preferences`;
}

export async function getNotificationPreferences(
  client: ApiClient,
  organizationSlug: string,
): Promise<NotificationPreferencesView> {
  const { data } = await client.request<NotificationPreferencesView>({
    path: path(organizationSlug),
  });
  return data;
}

export async function updateNotificationPreferences(
  client: ApiClient,
  organizationSlug: string,
  settings: NotificationPreferencesView,
): Promise<NotificationPreferencesView> {
  const { data } = await client.request<NotificationPreferencesView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: settings,
  });
  return data;
}

/**
 * The quiet-hours window to show: the NOTIF-001 window when one is stored (it is the one delivery
 * honours), with the weekdays only PREF-QUIET keeps; otherwise the PREF-QUIET view as it is.
 */
export function effectiveQuietHours(
  quiet: QuietHoursView,
  notification: NotificationPreferencesView | undefined,
): QuietHoursView {
  if (!notification?.quietHoursStart || !notification.quietHoursEnd) return quiet;
  return {
    enabled: true,
    startTime: notification.quietHoursStart.slice(0, 5),
    endTime: notification.quietHoursEnd.slice(0, 5),
    timezone: notification.quietHoursTimezone ?? quiet.timezone,
    days: quiet.days,
  };
}

/** The NOTIF-001 PUT body for a saved window: the other settings unchanged, the window replaced. */
export function withQuietWindow(
  current: NotificationPreferencesView,
  window: QuietHoursView,
): NotificationPreferencesView {
  return {
    ...current,
    quietHoursStart: window.enabled ? window.startTime : null,
    quietHoursEnd: window.enabled ? window.endTime : null,
    quietHoursTimezone: window.enabled ? window.timezone : null,
  };
}
