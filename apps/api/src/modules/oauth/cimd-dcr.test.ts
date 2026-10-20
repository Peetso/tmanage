import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './ssrf.js';
import { assertCimdUrl, CimdError } from './cimd-fetcher.js';
import { DcrValidationError, sanitiseClientName, validateDcrRegistration } from './dcr-metadata.js';
import { InvalidRedirectUrisError, validateRegistrationRedirectUris } from './redirect-uri.js';
import { isKnownCimdClient } from './known-clients.js';

/**
 * Unit coverage for the pure, security-critical S8 helpers (MCP connector S8). The network fetch
 * and the DB-backed DCR rate limit (T-DCR-02) are exercised by the security suite (S14) under a
 * server and MariaDB; here we pin the SSRF range decisions (T-SSRF-01) and the DCR metadata rules
 * (T-DCR-01) that those flows rely on, since a mistake in either is a silent hole.
 */

describe('SSRF address classification (threat model B5, T-SSRF-01)', () => {
  it('blocks loopback, private, CGNAT, link-local and metadata IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.100.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks loopback, unspecified, link-local, ULA and IPv4-mapped IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses, and blocks anything unparseable', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('0x7f.0.0.1')).toBe(true);
  });
});

describe('CIMD URL rules (threat model B5)', () => {
  it('accepts an https URL and refuses http, a fragment, credentials and a custom port', () => {
    expect(assertCimdUrl('https://claude.ai/.well-known/oauth-client').toString()).toContain(
      'claude.ai',
    );
    expect(() => assertCimdUrl('http://claude.ai/c')).toThrow(CimdError);
    expect(() => assertCimdUrl('https://claude.ai/c#x')).toThrow(CimdError);
    expect(() => assertCimdUrl('https://u:p@claude.ai/c')).toThrow(CimdError);
    expect(() => assertCimdUrl('https://claude.ai:8443/c')).toThrow(CimdError);
  });

  it('marks only known first-party hosts verified (exact host or subdomain)', () => {
    expect(isKnownCimdClient('https://claude.ai/c')).toBe(true);
    expect(isKnownCimdClient('https://api.openai.com/c')).toBe(true);
    expect(isKnownCimdClient('https://claude.ai.evil.com/c')).toBe(false);
    expect(isKnownCimdClient('http://claude.ai/c')).toBe(false);
  });
});

describe('DCR metadata validation and sanitising (threat model B1, T-DCR-01)', () => {
  const base = { redirect_uris: ['https://app.example/cb'] };

  it('accepts a valid body and returns the sanitised name and redirects', () => {
    const out = validateDcrRegistration({ ...base, client_name: 'My App' });
    expect(out).toEqual({ name: 'My App', redirectUris: ['https://app.example/cb'] });
  });

  it('strips control characters and caps the name at 60 characters', () => {
    expect(sanitiseClientName('a\u0000b\tc\nd')).toBe('a b c d');
    expect(sanitiseClientName('x'.repeat(100)).length).toBe(60);
    expect(validateDcrRegistration(base).name).toBe('AI client');
  });

  it('refuses a javascript: redirect, http non-loopback, and an empty set', () => {
    expect(() => validateDcrRegistration({ redirect_uris: ['javascript:alert(1)'] })).toThrow(
      DcrValidationError,
    );
    expect(() => validateDcrRegistration({ redirect_uris: ['http://app.example/cb'] })).toThrow(
      DcrValidationError,
    );
    expect(() => validateRegistrationRedirectUris([])).toThrow(InvalidRedirectUrisError);
  });

  it('refuses an unsupported grant type and a non-none auth method', () => {
    expect(() => validateDcrRegistration({ ...base, grant_types: ['client_credentials'] })).toThrow(
      DcrValidationError,
    );
    expect(() =>
      validateDcrRegistration({ ...base, token_endpoint_auth_method: 'client_secret_basic' }),
    ).toThrow(DcrValidationError);
    expect(() => validateDcrRegistration({ ...base, logo_uri: 'http://x/logo.png' })).toThrow(
      DcrValidationError,
    );
  });
});
