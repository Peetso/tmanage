import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationCompact } from '../src/lib/i18n/duration';

/**
 * WX3 (review R2): the work page's Time row is a narrow column, so Arabic draws the one-letter
 * units (Figma `WV2-02` AR "3 س 20 د من 6 س") instead of the long words that were cut to "…6".
 */
describe('formatDurationCompact', () => {
  it('writes Arabic hours and minutes as س and د', () => {
    expect(formatDurationCompact(200, 'ar')).toBe('3 س 20 د');
    expect(formatDurationCompact(360, 'ar')).toBe('6 س');
    expect(formatDurationCompact(45, 'ar')).toBe('45 د');
  });

  it('is shorter than the long Arabic form it stands in for', () => {
    expect(formatDurationCompact(200, 'ar').length).toBeLessThan(formatDuration(200, 'ar').length);
  });

  it('leaves every other language on its own narrow form', () => {
    expect(formatDurationCompact(200, 'en')).toBe(formatDuration(200, 'en'));
    expect(formatDurationCompact(200, 'de')).toBe(formatDuration(200, 'de'));
  });
});
