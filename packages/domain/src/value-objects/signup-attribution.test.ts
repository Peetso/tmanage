import { describe, expect, it } from 'vitest';
import {
  parseSignupAttribution,
  signupAttributionCookieValue,
  signupAttributionFromCookie,
  signupReferrerHost,
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

  it('keeps only the referring host, never the address, and not our own site (SEOD)', () => {
    const own = ['tmanageapp.com'];
    expect(signupReferrerHost('https://ChatGPT.com/c/123?q=secret#x', own)).toBe('chatgpt.com');
    expect(signupReferrerHost('https://user:pw@www.perplexity.ai:8443/search', own)).toBe(
      'www.perplexity.ai',
    );
    for (const bad of [
      'https://tmanageapp.com/pricing',
      'https://app.tmanageapp.com/',
      'https://192.168.1.10/',
      'http://localhost:3000/',
      'https://[::1]/',
      'javascript:alert(1)',
      'android-app://com.google.android.gm/',
      `https://${'a'.repeat(250)}.com/`,
      'not a url',
      null,
    ]) {
      expect(signupReferrerHost(bad, own)).toBeUndefined();
    }
  });

  it('carries the host through the cookie and re-validates it on read', () => {
    const value = signupAttributionCookieValue({
      utm_source: 'chatgpt.com',
      referrer_host: 'chatgpt.com',
    });
    expect(signupAttributionFromCookie(value)).toEqual({
      utm_source: 'chatgpt.com',
      referrer_host: 'chatgpt.com',
    });
    expect(signupAttributionFromCookie('referrer_host=evil.example%2Fpath')).toBeUndefined();
    expect(signupAttributionFromCookie('referrer_host=bing.com')).toEqual({
      referrer_host: 'bing.com',
    });
  });
});
