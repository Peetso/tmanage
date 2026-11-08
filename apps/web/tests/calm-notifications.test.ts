import { describe, expect, it } from 'vitest';
import { withCalmPreset } from '../src/lib/calm-notifications';

describe('withCalmPreset (C24)', () => {
  it('sets the daily digest and quiet evenings in the member zone, channels unchanged', () => {
    const result = withCalmPreset(
      {
        inAppEnabled: true,
        emailEnabled: false,
        digestFrequency: 'off',
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursTimezone: null,
      },
      'Africa/Cairo',
    );
    expect(result).toEqual({
      inAppEnabled: true,
      emailEnabled: false,
      digestFrequency: 'daily',
      quietHoursStart: '19:00:00',
      quietHoursEnd: '08:00:00',
      quietHoursTimezone: 'Africa/Cairo',
    });
  });
});
