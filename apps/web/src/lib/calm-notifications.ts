import { notificationDefaultsFor } from '@tmanage/domain';
import type { NotificationPreferencesView } from './api/notification-preferences';

/**
 * C24: the "calm" notification preset, applied to the member's own NOTIF-001 settings — the same
 * values the org's `calm` profile gives an unsaved member (`notificationDefaultsFor('calm')`: one
 * daily digest, quiet evenings), with the quiet window read in the member's own time zone. The
 * channels stay as the member has them; required-action kinds still arrive at once (the delivery
 * worker never holds those back), so the preset only quiets the rest.
 */
export function withCalmPreset(
  current: NotificationPreferencesView,
  timezone: string,
): NotificationPreferencesView {
  const calm = notificationDefaultsFor('calm');
  return {
    ...current,
    digestFrequency: calm.digestFrequency,
    quietHoursStart: calm.quietHoursStart,
    quietHoursEnd: calm.quietHoursEnd,
    quietHoursTimezone: calm.quietHoursStart === null ? null : timezone,
  };
}
