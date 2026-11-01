import { describe, expect, it } from 'vitest';
import {
  LEGACY_TIME_ZONE_NAMES,
  allTimeZones,
  canonicalTimeZone,
  isTimeZone,
  timeZoneLabel,
  timeZoneOffset,
  timeZoneOptions,
} from '../src/lib/time-zones';
import { TIME_ZONE_COUNTRIES } from '../src/lib/time-zones-data';

/** R9 — "time zone should be all countries": one complete, searchable list for every picker. */
describe('time zones (R9)', () => {
  const winter = new Date('2026-01-15T12:00:00Z');

  it('offers every country, UTC first, current names only and no duplicates', () => {
    const zones = allTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones.length).toBeGreaterThanOrEqual(419);
    const countries = new Set(zones.map((zone) => TIME_ZONE_COUNTRIES[zone]).filter(Boolean));
    expect(countries.size).toBeGreaterThan(240);
    for (const zone of ['Africa/Cairo', 'Asia/Riyadh', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
      expect(zones).toContain(zone);
    }
    for (const retired of Object.keys(LEGACY_TIME_ZONE_NAMES)) {
      expect(zones).not.toContain(retired);
    }
  });

  it('keeps the static table complete and every entry usable by the runtime', () => {
    for (const zone of Object.keys(TIME_ZONE_COUNTRIES)) {
      expect(isTimeZone(zone), zone).toBe(true);
    }
  });

  it('labels a zone with its offset, city and country, in the reader language', () => {
    expect(timeZoneLabel('Africa/Cairo', { locale: 'en', at: winter })).toBe(
      '(GMT+2) Cairo, Egypt',
    );
    expect(timeZoneLabel('Asia/Kolkata', { locale: 'en', at: winter })).toBe(
      '(GMT+5:30) Kolkata, India',
    );
    expect(timeZoneLabel('America/New_York', { locale: 'en', at: winter })).toBe(
      '(GMT-5) New York, United States',
    );
    expect(timeZoneLabel('Africa/Cairo', { locale: 'ar', at: winter })).toBe('(GMT+2) Cairo، مصر');
    expect(timeZoneLabel('UTC', { locale: 'en', at: winter, utcName: 'Coordinated' })).toBe(
      '(GMT+0) Coordinated',
    );
  });

  it('reads the offset for the date asked about, not just today', () => {
    expect(timeZoneOffset('Europe/London', winter)).toBe('GMT+0');
    expect(timeZoneOffset('Europe/London', new Date('2026-07-15T12:00:00Z'))).toBe('GMT+1');
    expect(timeZoneOffset('Not/AZone', winter)).toBe('');
  });

  it('always offers the stored value, in place of its current name when it is retired', () => {
    const legacy = timeZoneOptions('Asia/Calcutta', { locale: 'en', at: winter });
    expect(legacy.some((option) => option.value === 'Asia/Calcutta')).toBe(true);
    expect(legacy.some((option) => option.value === 'Asia/Kolkata')).toBe(false);

    const unknown = timeZoneOptions('Mars/Olympus_Mons', { locale: 'en', at: winter });
    expect(unknown.some((option) => option.value === 'Mars/Olympus_Mons')).toBe(true);
  });

  it('orders west to east and finds a zone by city, country or offset', () => {
    const options = timeZoneOptions('UTC', { locale: 'en', at: winter });
    const index = (zone: string) => options.findIndex((option) => option.value === zone);
    expect(index('Pacific/Pago_Pago')).toBeLessThan(index('America/New_York'));
    expect(index('America/New_York')).toBeLessThan(index('Africa/Cairo'));
    expect(index('Africa/Cairo')).toBeLessThan(index('Pacific/Kiritimati'));
    const find = (text: string) =>
      options.filter((option) => option.label.toLowerCase().includes(text)).map((o) => o.value);
    expect(find('cairo')).toEqual(['Africa/Cairo']);
    expect(find('egypt')).toEqual(['Africa/Cairo']);
    expect(find('gmt+5:30')).toEqual(expect.arrayContaining(['Asia/Kolkata', 'Asia/Colombo']));
  });

  it('accepts real zones only', () => {
    expect(isTimeZone('Africa/Cairo')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('+03:00')).toBe(false);
    expect(isTimeZone('Mars/Phobos')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(canonicalTimeZone('Europe/Kiev')).toBe('Europe/Kyiv');
  });
});
