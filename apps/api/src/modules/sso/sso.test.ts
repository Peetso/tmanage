import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decideWithSsoEnforcement } from './sso-enforcement.js';
import {
  newSsoFlow,
  openSsoFlow,
  sealSsoFlow,
  ssoStateMatches,
  verifySsoIdToken,
  type SsoJwk,
} from './sso-oidc.js';
import { parseSsoSettings, SsoService, type SsoServiceDeps } from './sso.service.js';

const ISSUER = 'https://login.northstar.example';
const CLIENT = 'tmanage-web';
const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS: SsoJwk[] = [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }];

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims: Record<string, unknown> = {}, signer = privateKey): string {
  const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({
    iss: ISSUER,
    aud: CLIENT,
    sub: 'u-1',
    email: 'Rana@Northstar.example',
    nonce: 'n-1',
    iat: NOW,
    exp: NOW + 300,
    ...claims,
  })}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(signer).toString('base64url')}`;
}
const verify = (idToken: string, nonce = 'n-1') =>
  verifySsoIdToken({
    idToken,
    issuer: ISSUER,
    clientId: CLIENT,
    nonce,
    keys: KEYS,
    nowSeconds: NOW,
  });

describe('54-14 company sign-in: ID token checks', () => {
  it('accepts a good token and lower-cases the address', () => {
    expect(verify(token())).toEqual({ subject: 'u-1', email: 'rana@northstar.example', name: '' });
  });

  it('refuses a nonce that is not the flow cookie nonce', () => {
    expect(() => verify(token(), 'n-other')).toThrow(
      expect.objectContaining({ reason: 'bad_nonce' }),
    );
  });

  it('refuses a token signed by another key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => verify(token({}, other))).toThrow(
      expect.objectContaining({ reason: 'bad_signature' }),
    );
  });

  it('refuses a token for another client and from another issuer', () => {
    expect(() => verify(token({ aud: 'someone-else' }))).toThrow(
      expect.objectContaining({ reason: 'wrong_audience' }),
    );
    expect(() => verify(token({ iss: 'https://evil.example' }))).toThrow(
      expect.objectContaining({ reason: 'wrong_issuer' }),
    );
  });

  it('refuses an expired token and one the provider marked unverified', () => {
    expect(() => verify(token({ exp: NOW - 120 }))).toThrow(
      expect.objectContaining({ reason: 'expired' }),
    );
    expect(() => verify(token({ email_verified: false }))).toThrow(
      expect.objectContaining({ reason: 'email_unverified' }),
    );
  });
});

describe('54-14 company sign-in: flow cookie', () => {
  it('refuses a forged cookie and a state that does not match', () => {
    const flow = newSsoFlow('org-1', NOW);
    const sealed = sealSsoFlow(flow, 'secret');
    expect(openSsoFlow(sealed, 'secret', NOW)).toEqual(flow);
    expect(openSsoFlow(sealed, 'other-secret', NOW)).toBeUndefined();
    expect(openSsoFlow(sealed, 'secret', NOW + 601)).toBeUndefined();
    expect(ssoStateMatches(flow, flow.state)).toBe(true);
    expect(ssoStateMatches(flow, 'attacker-state')).toBe(false);
    expect(ssoStateMatches(flow, undefined)).toBe(false);
  });
});

describe('54-14 company sign-in: membership and enforcement', () => {
  it('refuses an address outside the allowed domains before touching any account', async () => {
    const recordAuthenticationEvent = vi.fn();
    const findUserByEmail = vi.fn();
    const deps = {
      database: { identityTransaction: (_o: unknown, work: (tx: unknown) => unknown) => work({}) },
      credentials: { recordAuthenticationEvent, listActiveFactors: vi.fn() },
      identities: { findUserByEmail },
      sessionSecret: 's',
      webPublicUrl: 'https://app.example',
    } as unknown as SsoServiceDeps;
    const outcome = await new SsoService(deps).complete(
      {
        id: 'c1',
        organizationId: 'org-1',
        slug: 'northstar',
        issuer: ISSUER,
        clientId: CLIENT,
        clientSecretEnc: 'x',
        allowedDomains: 'northstar.example',
        autoJoin: true,
        protocol: 'oidc',
        samlEntityId: '',
        samlSsoUrl: '',
        samlCertificate: '',
      },
      { subject: 'u-1', email: 'rana@elsewhere.example', name: '' },
      { correlationId: 'c' },
    );
    expect(outcome).toEqual({ kind: 'refused', reason: 'domain' });
    expect(findUserByEmail).not.toHaveBeenCalled();
    expect(recordAuthenticationEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ reason: 'sso_domain_not_allowed' }),
    );
  });

  it('blocks a non-owner member password sign-in when enforced, but not the owner', () => {
    const row = { kind: 'internal' as const, slug: 'northstar', policy: null, enforceSso: true };
    expect(decideWithSsoEnforcement([{ ...row, role: 'member' }], 'password')).toEqual({
      use: ['sso'],
      organization: 'northstar',
    });
    expect(decideWithSsoEnforcement([{ ...row, role: 'owner' }], 'password')).toBeNull();
    expect(decideWithSsoEnforcement([{ ...row, role: 'member' }], 'sso')).toBeNull();
  });

  it('refuses public mail domains and plain http issuers in the settings', () => {
    const base = { clientId: CLIENT, enforce: false, autoJoin: false };
    expect(() =>
      parseSsoSettings({ ...base, issuer: ISSUER, allowedDomains: ['gmail.com'] }),
    ).toThrow();
    expect(() =>
      parseSsoSettings({ ...base, issuer: 'http://login.example', allowedDomains: ['a.example'] }),
    ).toThrow();
  });
});
