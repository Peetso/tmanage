import { describe, expect, it } from 'vitest';
import { regionForTimezone } from './person-region.js';

describe('EMAILBUILD — region of a reader', () => {
  it('uses the workspace time zone first, then the language, else west', () => {
    expect(regionForTimezone('Africa/Cairo', 'en')).toBe('me');
    expect(regionForTimezone('Asia/Dubai', 'en')).toBe('me');
    expect(regionForTimezone('Asia/Tokyo', 'ar')).toBe('asia');
    expect(regionForTimezone('Europe/Berlin', 'ar')).toBe('west');
    expect(regionForTimezone('Australia/Sydney', 'en')).toBe('west');
    expect(regionForTimezone('UTC', 'ar')).toBe('me');
    expect(regionForTimezone(null, 'en')).toBe('west');
  });
});
