import { describe, expect, it } from 'vitest';
import {
  effectiveQuietHours,
  withQuietWindow,
  type NotificationPreferencesView,
} from '../src/lib/api/notification-preferences';
import type { QuietHoursView } from '../src/lib/api/quiet-hours';

/** B4: the quiet-hours form shows the window saved in NOTIF-001, and a save keeps both in step. */

const unsaved: QuietHoursView = {
  enabled: false,
  startTime: '22:00',
  endTime: '07:00',
  timezone: 'UTC',
  days: [0, 1, 2, 3, 4, 5, 6],
};

const saved: NotificationPreferencesView = {
  inAppEnabled: true,
  emailEnabled: false,
  digestFrequency: 'daily',
  quietHoursStart: '19:00:00',
  quietHoursEnd: '08:00:00',
  quietHoursTimezone: 'Africa/Cairo',
};

describe('effective quiet hours', () => {
  it('shows the saved NOTIF-001 window, and a save writes it back with the other settings kept', () => {
    const shown = effectiveQuietHours(unsaved, saved);
    expect(shown).toEqual({
      ...unsaved,
      enabled: true,
      startTime: '19:00',
      endTime: '08:00',
      timezone: 'Africa/Cairo',
    });
    expect(
      effectiveQuietHours(unsaved, { ...saved, quietHoursStart: null, quietHoursEnd: null }),
    ).toBe(unsaved);
    expect(withQuietWindow(saved, { ...shown, enabled: false })).toEqual({
      ...saved,
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    });
  });
});
