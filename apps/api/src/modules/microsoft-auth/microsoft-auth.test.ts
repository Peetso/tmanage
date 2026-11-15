import 'reflect-metadata';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { SessionService } from '../identity/session.service.js';
import type { GoogleAuthService } from '../google-auth/google-auth.service.js';
import {
  IdTokenRejectedError,
  newFlow,
  openFlow,
  sealFlow,
  type GoogleFlow,
} from '../google-auth/google-oidc.js';
import { MicrosoftAuthController } from './microsoft-auth.controller.js';
import {
  authorizationUrl,
  MICROSOFT_CONSUMER_TENANT,
  MICROSOFT_FLOW_COOKIE,
  MICROSOFT_FLOW_PURPOSE,
  microsoftSignInConfigFrom,
  verifyMicrosoftIdToken,
  type MicrosoftJwk,
  type MicrosoftSignInConfig,
  type MicrosoftTransport,
} from './microsoft-oidc.js';

const SECRET = 'session-secret-for-microsoft-tests-0123456789';
const NOW = 1_800_000_000;
const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CONFIG: MicrosoftSignInConfig = {
  clientId: 'ms-client-1',
  clientSecret: 's',
  tenant: 'common',
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK: MicrosoftJwk = {
  ...(publicKey.export({ format: 'jwk' }) as object),
  kid: 'k1',
  issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
};

function idToken(overrides: Record<string, unknown> = {}): string {
  const tid = (overrides['tid'] as string | undefined) ?? MICROSOFT_CONSUMER_TENANT;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://login.microsoftonline.com/${tid}/v2.0`,
      aud: CONFIG.clientId,
      tid,
      oid: '00000000-0000-0000-66f3-3332eca7ea81',
      sub: 'pairwise-sub',
      email: 'Mona@Outlook.com',
      name: 'Mona Adel',
      nonce: 'nonce-1',
      iat: NOW - 10,
      exp: NOW + 3600,
      ...overrides,
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

function reasonOf(token: string, config: MicrosoftSignInConfig = CONFIG): string | undefined {
  try {
    verifyMicrosoftIdToken({
      idToken: token,
      config,
      nonce: 'nonce-1',
      keys: [JWK],
      nowSeconds: NOW,
    });
  } catch (error) {
    if (error instanceof IdTokenRejectedError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('verifyMicrosoftIdToken', () => {
  it('accepts a personal account and keys it by tenant and object id', () => {
    expect(
      verifyMicrosoftIdToken({
        idToken: idToken(),
        config: CONFIG,
        nonce: 'nonce-1',
        keys: [JWK],
        nowSeconds: NOW,
      }),
    ).toEqual({
      subject: `${MICROSOFT_CONSUMER_TENANT}:00000000-0000-0000-66f3-3332eca7ea81`,
      email: 'mona@outlook.com',
      name: 'Mona Adel',
    });
  });

  it('refuses an issuer that is not the token’s own tenant, and a tenant outside the pin', () => {
    expect(
      reasonOf(idToken({ iss: `https://login.microsoftonline.com/${WORK_TENANT}/v2.0` })),
    ).toBe('wrong_issuer');
    expect(reasonOf(idToken({ iss: 'https://sts.windows.net/x/' }))).toBe('wrong_issuer');
    expect(reasonOf(idToken(), { ...CONFIG, tenant: 'organizations' })).toBe('wrong_issuer');
  });

  it('refuses a token for another application', () => {
    expect(reasonOf(idToken({ aud: 'someone-else' }))).toBe('wrong_audience');
  });

  it('a work account e-mail counts only when the domain owner verified it (xms_edov)', () => {
    expect(reasonOf(idToken({ tid: WORK_TENANT }))).toBe('email_unverified');
    expect(reasonOf(idToken({ tid: WORK_TENANT, xms_edov: true }))).toBeUndefined();
  });
});

describe('the Microsoft flow', () => {
  it('sends the S256 challenge of the cookie’s verifier; a Google flow cookie never opens here', () => {
    const flow = newFlow('sign-in', {}, NOW);
    const url = new URL(authorizationUrl({ config: CONFIG, redirectUri: 'https://x/cb', flow }));
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(flow.verifier).digest('base64url'),
    );
    expect(openFlow(sealFlow(flow, SECRET), SECRET, NOW, MICROSOFT_FLOW_PURPOSE)).toBeUndefined();
    expect(microsoftSignInConfigFrom({ MICROSOFT_SIGNIN_CLIENT_ID: 'a' })).toBeNull();
  });
});

function controllerFor(token: string) {
  const exchangeCode = vi.fn(async () => ({ idToken: token }));
  const transport: MicrosoftTransport = { exchangeCode, signingKeys: async () => [JWK] };
  const complete = vi.fn();
  const service = {
    record: vi.fn(async () => undefined),
    complete,
  } as unknown as GoogleAuthService;
  const controller = new MicrosoftAuthController(
    service,
    { start: vi.fn() } as unknown as SessionService,
    transport,
    {
      config: CONFIG,
      webPublicUrl: 'https://app.test',
      sessionSecret: SECRET,
      secureCookies: true,
    },
    () => true,
  );
  return { controller, exchangeCode, complete };
}

function requestWith(flow: GoogleFlow) {
  const request = {
    headers: {
      cookie: `${MICROSOFT_FLOW_COOKIE}=${sealFlow(flow, SECRET, MICROSOFT_FLOW_PURPOSE)}`,
    },
  };
  ensureRequestState(request);
  return request;
}

describe('MicrosoftAuthController callback', () => {
  const reply = { header: vi.fn() };

  it('a state that is not this browser’s is refused before the code is exchanged', async () => {
    const h = controllerFor(idToken());
    const flow = newFlow('sign-in');
    await expect(
      h.controller.callback({ state: 'other', code: 'c' }, requestWith(flow), reply),
    ).resolves.toEqual({ url: '/sign-in?microsoft_error=state', statusCode: 302 });
    expect(h.exchangeCode).not.toHaveBeenCalled();
  });

  it('an unverified work e-mail never reaches account linking', async () => {
    const flow = newFlow('sign-in');
    const h = controllerFor(
      idToken({
        tid: WORK_TENANT,
        nonce: flow.nonce,
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 600,
      }),
    );
    await expect(
      h.controller.callback({ state: flow.state, code: 'c' }, requestWith(flow), reply),
    ).resolves.toEqual({ url: '/sign-in?microsoft_error=unverified', statusCode: 302 });
    expect(h.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ verifier: flow.verifier }),
    );
    expect(h.complete).not.toHaveBeenCalled();
  });
});
