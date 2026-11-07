import { describe, expect, it } from 'vitest';
import { timeChoices } from '../src/components/screens/QuietHoursScreen';

describe('quiet hours time choices (C7: 24-hour, no AM/PM)', () => {
  it('lists quarter hours as HH:MM and keeps an off-grid saved value', () => {
    const grid = timeChoices('22:00');
    expect(grid).toHaveLength(96);
    expect(grid[0]).toBe('00:00');
    expect(grid).toContain('19:45');
    expect(timeChoices('19:07:00')).toContain('19:07');
  });
});
