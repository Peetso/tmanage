import { describe, expect, it } from 'vitest';
import {
  codeChallengeS256,
  isValidCodeChallenge,
  isValidCodeVerifier,
  verifyPkceS256,
} from './pkce.js';
import { isAllowedRedirectScheme, matchesRegisteredRedirect } from './redirect-uri.js';
import { DEFAULT_SCOPES, InvalidScopeError, parseScopes, scopesToString } from './scopes.js';

/**
 * Unit coverage for the pure, security-critical OAuth helpers (MCP connector S7). The DB-backed
 * flows (code exchange, refresh rotation and reuse) are exercised by the conformance suite
 * (T-OA-*) under MariaDB; here we pin the branch logic those flows rely on.
 */

describe('PKCE S256 (threat model B1, T-OA-02)', () => {
  // RFC 7636 appendix B worked example.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('computes the RFC 7636 challenge for a verifier', () => {
    expect(codeChallengeS256(verifier)).toBe(challenge);
  });

  it('verifies a matching verifier and rejects a wrong one', () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(`${verifier.slice(0, -1)}X`, challenge)).toBe(false);
  });

  it('rejects malformed challenges and verifiers (no plain, no short)', () => {
    expect(isValidCodeChallenge('plain')).toBe(false);
    expect(isValidCodeChallenge('too-short')).toBe(false);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeVerifier('short')).toBe(false);
    expect(isValidCodeVerifier(verifier)).toBe(true);
    expect(verifyPkceS256('plain', 'plain')).toBe(false);
  });
});

describe('redirect-uri rules (threat model B1, T-OA-03)', () => {
  const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:8787/cb'];

  it('accepts an exact https match', () => {
    expect(matchesRegisteredRedirect('https://claude.ai/api/mcp/auth_callback', registered)).toBe(
      true,
    );
  });

  it('refuses wildcards, prefixes, extra path segments and fragments', () => {
    expect(matchesRegisteredRedirect('https://claude.ai/api/mcp/auth_callback/x', registered)).toBe(
      false,
    );
    expect(matchesRegisteredRedirect('https://claude.ai/api/mcp', registered)).toBe(false);
    expect(matchesRegisteredRedirect('https://claude.ai/api/mcp/auth_callback#x', registered)).toBe(
      false,
    );
    expect(
      matchesRegisteredRedirect('https://evil.example/api/mcp/auth_callback', registered),
    ).toBe(false);
  });

  it('refuses http for a non-loopback host', () => {
    expect(isAllowedRedirectScheme('http://claude.ai/api/mcp/auth_callback')).toBe(false);
    expect(matchesRegisteredRedirect('http://claude.ai/api/mcp/auth_callback', registered)).toBe(
      false,
    );
  });

  it('matches a loopback redirect on any port (same scheme, host and path)', () => {
    expect(matchesRegisteredRedirect('http://127.0.0.1:54321/cb', registered)).toBe(true);
    expect(matchesRegisteredRedirect('http://127.0.0.1:1/cb', registered)).toBe(true);
    // ...but not a different path, and not https-vs-http.
    expect(matchesRegisteredRedirect('http://127.0.0.1:54321/other', registered)).toBe(false);
    expect(matchesRegisteredRedirect('https://127.0.0.1:8787/cb', registered)).toBe(false);
  });
});

describe('scopes (plan §4.2)', () => {
  it('defaults to read + write when none is asked', () => {
    expect(parseScopes(undefined)).toEqual(DEFAULT_SCOPES);
    expect(parseScopes('')).toEqual(DEFAULT_SCOPES);
  });

  it('returns known scopes in canonical order and de-duplicates', () => {
    expect(parseScopes('tmanage:write tmanage:read tmanage:read')).toEqual([
      'tmanage:read',
      'tmanage:write',
    ]);
    expect(scopesToString(['tmanage:write', 'tmanage:read'])).toBe('tmanage:read tmanage:write');
  });

  it('rejects an unknown scope rather than dropping it', () => {
    expect(() => parseScopes('tmanage:read tmanage:destroy')).toThrow(InvalidScopeError);
  });
});
