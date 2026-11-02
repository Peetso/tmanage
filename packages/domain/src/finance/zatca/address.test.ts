import { describe, expect, it } from 'vitest';
import { addressMissing, parseAddressJson } from './address.js';

/** 52-12 (R21-c) — the structured e-invoice address. */
describe('structured address', () => {
  const full = {
    building: '1234',
    street: 'King Fahd Rd',
    district: 'Al Olaya',
    city: 'Riyadh',
    postalCode: '12345',
    countryCode: 'sa',
  };

  it('parses an object or JSON text, drops unknown keys, trims and upper-cases the country', () => {
    const parsed = parseAddressJson({ ...full, city: '  Riyadh ', extra: 'x' });
    expect(parsed).toEqual({ ...full, countryCode: 'SA' });
    expect(parseAddressJson(JSON.stringify(full))).toEqual({ ...full, countryCode: 'SA' });
    expect(parseAddressJson({ city: 5 })).toBeNull();
    expect(parseAddressJson('not json')).toBeNull();
  });

  it('lists what each country still needs; a bad SA building number counts as missing', () => {
    const address = parseAddressJson(full);
    expect(addressMissing(address, 'SA')).toEqual([]);
    expect(addressMissing(null, 'AE')).toEqual(['street', 'city', 'countryCode']);
    expect(addressMissing(parseAddressJson({ ...full, building: '12' }), 'SA')).toEqual([
      'building',
    ]);
    expect(addressMissing(null, 'US')).toEqual([]);
  });
});
