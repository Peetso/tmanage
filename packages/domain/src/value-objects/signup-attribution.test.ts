import { describe, expect, it } from 'vitest';
import {
  parseSignupAttribution,
  signupAttributionCookieValue,
  signupAttributionFromCookie,
} from './signup-attribution.js';

describe('signup attribution (ADTRACK)', () => {
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

  it('reads back a cookie a writer percent-encoded, validating again', () => {
    const value = encodeURIComponent(
      signupAttributionCookieValue({ utm_source: 'facebook', utm_campaign: 'tm_beta_traffic' }),
    );
    expect(signupAttributionFromCookie(`${value}%26utm_medium%3Dbad%20value`)).toEqual({
      utm_source: 'facebook',
      utm_campaign: 'tm_beta_traffic',
    });
  });
});
