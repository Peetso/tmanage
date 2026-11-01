import { expect, it } from 'vitest';
import { StaticGeoLookup } from '../identity/geo/geo-lookup.js';
import { resolveLocaleHint as hint } from './locale-hint.controller.js';

const at = (countryCode: string) => ({ countryCode }) as never;
const geo = new StaticGeoLookup({ '203.0.113.1': at('MX'), '203.0.113.2': at('CH') });

it('R12 locale-hint: the country, then Accept-Language, then en-US', () => {
  const a = [hint(geo, '203.0.113.1', 'de'), hint(geo, '203.0.113.2', 'it, fr;q=0.8')];
  const b = [...a, hint(null, '10.0.0.1', undefined)].map((h) => Object.values(h).join(' '));
  expect(b.join()).toBe('MX es-ES geo,CH fr-FR accept-language, en-US default');
});
