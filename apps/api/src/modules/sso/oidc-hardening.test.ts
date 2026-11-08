import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { newSsoFlow, verifySsoIdToken, type SsoJwk } from './sso-oidc.js';
import { createSsoTransport } from './sso-transport.js';
import { SsoService, type SsoServiceDeps } from './sso.service.js';

/**
 * 56-10o — OIDC hardening corpus for company sign-in. Each case is a token or flow an attacker
 * could hand the callback; every one must be refused with its named reason.
 */

const ISSUER = 'https://login.northstar.example';
const CLIENT = 'tmanage-web';
const NOW = 1_800_000_000;
const CORR = '0190f0a0-0000-7000-8000-0000000000c1';
const ORG = '0190f0a0-0000-7000-8000-000000000001';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = publicKey.export({ format: 'jwk' });
const KEYS: SsoJwk[] = [{ ...JWK, kid: 'k1', use: 'sig' }];

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: 'u-1',
  email: 'rana@northstar.example',
  nonce: 'n-1',
  iat: NOW,
  exp: NOW + 300,
  ...extra,
});
function rs256(payload: object, header: object = { alg: 'RS256', kid: 'k1' }, key = privateKey) {
  const head = `${b64(header)}.${b64(payload)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
}
const verify = (idToken: string, keys: SsoJwk[] = KEYS, nonce = 'n-1') =>
  verifySsoIdToken({ idToken, issuer: ISSUER, clientId: CLIENT, nonce, keys, nowSeconds: NOW });
const refused = (idToken: string, reason: string, keys?: SsoJwk[]) =>
  expect(() => verify(idToken, keys)).toThrow(expect.objectContaining({ reason }));

describe('56-10o OIDC corpus: algorithm and key confusion', () => {
  it('refuses alg none with an empty signature and with any signature', () => {
    const head = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}`;
    refused(`${head}.`, 'malformed');
    refused(`${head}.AAAA`, 'unsupported_algorithm');
  });

  it('refuses HS256 signed with the public key as the HMAC secret', () => {
    const head = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(claims())}`;
    const pem = publicKey.export({ format: 'pem', type: 'spki' });
    const mac = createHmac('sha256', pem).update(head).digest('base64url');
    refused(`${head}.${mac}`, 'unsupported_algorithm');
  });

  it('refuses a kid that names an encryption key, a key pinned to another alg, or two keys', () => {
    refused(rs256(claims()), 'unknown_key', [{ ...JWK, kid: 'k1', use: 'enc' }]);
    refused(rs256(claims()), 'unknown_key', [{ ...JWK, kid: 'k1', alg: 'RS512' }]);
    refused(rs256(claims()), 'unknown_key', [
      { ...JWK, kid: 'k1' },
      { ...JWK, kid: 'k1' },
    ]);
    refused(rs256(claims(), { alg: 'RS256', kid: 7 }), 'unknown_key');
  });

  it('refuses a kid-less token when the issuer publishes several keys', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      format: 'jwk',
    });
    refused(rs256(claims(), { alg: 'RS256' }), 'unknown_key', [
      { ...JWK, kid: 'k1' },
      { ...other, kid: 'k2' },
    ]);
    expect(verify(rs256(claims(), { alg: 'RS256' }), [{ ...JWK }]).subject).toBe('u-1');
  });

  it('refuses a token signed by another issuer key published under the same kid', () => {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    refused(rs256(claims(), undefined, attacker), 'bad_signature');
  });
});

describe('56-10o OIDC corpus: claims', () => {
  it('refuses a token minted for another client, and an azp naming another client', () => {
    refused(rs256(claims({ aud: 'other-client' })), 'wrong_audience');
    refused(
      rs256(claims({ aud: [CLIENT, 'other-client'], azp: 'other-client' })),
      'wrong_audience',
    );
    refused(rs256(claims({ aud: [CLIENT, 'other-client'] })), 'wrong_audience');
    refused(rs256(claims({ azp: 'other-client' })), 'wrong_audience');
    expect(verify(rs256(claims({ aud: [CLIENT, 'x'], azp: CLIENT }))).subject).toBe('u-1');
  });

  it('refuses a token from another issuer even with a valid signature', () => {
    refused(rs256(claims({ iss: 'https://evil.example' })), 'wrong_issuer');
  });

  it('refuses iat and nbf far in the future', () => {
    refused(rs256(claims({ iat: NOW + 3600, exp: NOW + 7200 })), 'issued_in_future');
    refused(rs256(claims({ nbf: NOW + 3600 })), 'issued_in_future');
  });

  it('refuses a token carrying the nonce of an earlier flow (nonce replay)', () => {
    expect(() => verify(rs256(claims({ nonce: 'n-earlier' })))).toThrow(
      expect.objectContaining({ reason: 'bad_nonce' }),
    );
  });
});

describe('56-10o OIDC corpus: discovery and flow', () => {
  it('refuses a discovery document that claims another issuer (JWKS of another issuer)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: 'https://evil.example',
            authorization_endpoint: 'https://evil.example/a',
            token_endpoint: 'https://evil.example/t',
            jwks_uri: 'https://evil.example/jwks',
          }),
          { status: 200 },
        ),
    );
    const transport = createSsoTransport(fetchImpl as unknown as typeof fetch, async () => [
      '93.184.216.34',
    ]);
    await expect(transport.discover(ISSUER)).rejects.toThrow('discovery issuer mismatch');
  });

  it('refuses a reused state before any code exchange (state reuse)', async () => {
    const consumed = new Set<string>();
    const exchangeCode = vi.fn(async () => ({ idToken: rs256(claims()) }));
    const deps = {
      database: {
        bootstrapRead: async (_o: unknown, work: (db: unknown) => unknown) => work({}),
        transaction: async (_c: unknown, work: (tx: unknown) => unknown) => work({}),
      },
      cipher: { decrypt: () => 'secret' },
      transport: {
        discover: async () => ({
          issuer: ISSUER,
          authorizationEndpoint: '',
          tokenEndpoint: 't',
          jwksUri: 'j',
        }),
        signingKeys: async () => KEYS,
        exchangeCode,
      },
      repository: {
        findByOrganization: async () => ({
          id: 'c1',
          organizationId: ORG,
          protocol: 'oidc',
          issuer: ISSUER,
          clientId: CLIENT,
          clientSecretEnc: 'enc',
        }),
      },
      samlRequests: {
        consumeRequest: async (_tx: unknown, _ctx: unknown, id: string) => {
          if (consumed.has(id)) return false;
          consumed.add(id);
          return true;
        },
      },
      sessionSecret: 's',
      webPublicUrl: 'https://app.example',
      now: () => NOW * 1000,
    } as unknown as SsoServiceDeps;
    const service = new SsoService(deps);
    const flow = { ...newSsoFlow(ORG, NOW), nonce: 'n-1' };
    await expect(service.verify(flow, 'code-1', CORR)).resolves.toMatchObject({
      claims: { subject: 'u-1' },
    });
    await expect(service.verify(flow, 'code-1', CORR)).rejects.toMatchObject({
      reason: 'replayed',
    });
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });
});
