import { describe, expect, it } from 'vitest';
import * as attribution from './signup-attribution.js';
import { parseSignupAttribution, signupAttributionFromInput } from './signup-attribution.js';

describe('signup attribution (ADTRACK, carried in the address since NOCOOKIE)', () => {
  it('keeps valid utm values and drops anything too long or outside [A-Za-z0-9_.-]', () => {
    const params = new URLSearchParams({
      utm_source: 'facebook',
      utm_medium: '<script>',
      utm_campaign: 'x'.repeat(101),
      utm_content: 'en_carousel',
      utm_term: 'ignored',
    });
    expect(parseSignupAttribution((key) => params.get(key))).toEqual({
      utm_source: 'facebook',
      utm_content: 'en_carousel',
    });
  });

  it('reads a request body field, validating again and ignoring anything else', () => {
    expect(
      signupAttributionFromInput({
        utm_source: 'facebook',
        utm_campaign: 'tm_beta_traffic',
        utm_medium: 'bad value',
        referrer_host: 'evil.example',
        constructor: 'x',
      }),
    ).toEqual({ utm_source: 'facebook', utm_campaign: 'tm_beta_traffic' });
    for (const bad of [undefined, null, 'utm_source=facebook', ['facebook'], { utm_source: 7 }]) {
      expect(signupAttributionFromInput(bad)).toBeUndefined();
    }
  });

  it('offers no way to write or read an attribution cookie any more', () => {
    expect(Object.keys(attribution).filter((name) => /cookie/i.test(name))).toEqual([
      'LEGACY_SIGNUP_ATTRIBUTION_COOKIE',
    ]);
  });
});
