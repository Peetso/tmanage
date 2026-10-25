import 'reflect-metadata';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { ApiError } from '../../common/http/errors.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { SessionService } from '../identity/session.service.js';
import type { PublicSignupService } from '../signup/public-signup.service.js';
import type { SignupAccountsRepository } from '../signup/signup-accounts.repository.js';
import { GoogleAuthController, type GoogleAuthOptions } from './google-auth.controller.js';
import { GoogleAuthService, type InvitationsPort } from './google-auth.service.js';
import {
  GOOGLE_FLOW_COOKIE,
  IdTokenRejectedError,
  newFlow,
  openFlow,
  sealFlow,
  verifyIdToken,
  type GoogleClaims,
  type GoogleFlow,
  type GoogleJwk,
  type GoogleTransport,
} from './google-oidc.js';
import type { UserIdentitiesRepository } from './user-identities.repository.js';

const SECRET = 'session-secret-for-google-tests-0123456789';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const NOW = 1_800_000_000;
const CORR = '0199aa00-0000-7000-8000-0000000000d1';
const INVITE_TOKEN = 'i'.repeat(43);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK: GoogleJwk = {
  ...(publicKey.export({ format: 'jwk' }) as object),
  kid: 'k1',
  alg: 'RS256',
};

function idToken(overrides: Record<string, unknown> = {}, kid = 'k1'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: 'google-sub-1',
      email: 'Mona@Example.com',
      email_verified: true,
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

const verify = (token: string, nonce = 'nonce-1') =>
  verifyIdToken({ idToken: token, clientId: CLIENT_ID, nonce, keys: [JWK], nowSeconds: NOW });

function reasonOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof IdTokenRejectedError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('verifyIdToken', () => {
  it('accepts a good token and normalises the email', () => {
    expect(verify(idToken())).toEqual({
      subject: 'google-sub-1',
      email: 'mona@example.com',
      name: 'Mona Adel',
    });
  });
  it('refuses a wrong audience', () => {
    expect(
      reasonOf(() => verify(idToken({ aud: 'someone-else.apps.googleusercontent.com' }))),
    ).toBe('wrong_audience');
    expect(reasonOf(() => verify(idToken({ aud: [CLIENT_ID, 'x'], azp: 'x' })))).toBe(
      'wrong_audience',
    );
  });
  it('refuses a bad nonce', () => {
    expect(reasonOf(() => verify(idToken(), 'another-nonce'))).toBe('bad_nonce');
  });
  it('refuses an unverified email', () => {
    expect(reasonOf(() => verify(idToken({ email_verified: false })))).toBe('email_unverified');
  });
  it('refuses an expired token, a wrong issuer and a forged signature', () => {
    expect(reasonOf(() => verify(idToken({ exp: NOW - 3600 })))).toBe('expired');
    expect(reasonOf(() => verify(idToken({ iss: 'https://evil.example' })))).toBe('wrong_issuer');
    const [h, , s] = idToken().split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.${s}`;
    expect(reasonOf(() => verify(forged))).toBe('bad_signature');
    expect(reasonOf(() => verify(idToken({}, 'unknown-kid')))).toBe('unknown_key');
  });
});

describe('the flow cookie', () => {
  it('round-trips, and a forged or expired cookie opens to nothing', () => {
    const flow = newFlow('sign-in', {}, NOW);
    const sealed = sealFlow(flow, SECRET);
    expect(openFlow(sealed, SECRET, NOW)).toEqual(flow);
    expect(openFlow(sealed, 'a-different-secret-entirely-0123456789', NOW)).toBeUndefined();
    expect(
      openFlow(
        sealed.replace(/.$/u, (c) => (c === 'A' ? 'B' : 'A')),
        SECRET,
        NOW,
      ),
    ).toBeUndefined();
    expect(openFlow(sealed, SECRET, NOW + 3600)).toBeUndefined();
  });
});

// ── the service's rules ──────────────────────────────────────────────────────

interface World {
  bySubject?: string;
  byEmail?: string;
  /** Whether the `byEmail` account ever proved its address; true unless a test says otherwise. */
  byEmailVerified?: boolean;
  factors?: number;
  invitedEmail?: string;
  signupOpen?: boolean;
}

function serviceFor(world: World) {
  const runner = {};
  const database = {
    identityTransaction: vi.fn(async (_o: unknown, work: (r: unknown) => unknown) => work(runner)),
    identityRead: vi.fn(async (_o: unknown, work: (r: unknown) => unknown) => work(runner)),
  } as unknown as TenantDatabase;
  const link = vi.fn(async () => undefined);
  const identities = {
    findUserBySubject: vi.fn(async () => (world.bySubject ? { userId: world.bySubject } : null)),
    findUserByEmail: vi.fn(async () =>
      world.byEmail
        ? {
            userId: world.byEmail,
            emailVerifiedAt:
              world.byEmailVerified === false ? null : new Date('2026-10-01T00:00:00.000Z'),
          }
        : null,
    ),
    link,
    touch: vi.fn(async () => undefined),
  } as unknown as UserIdentitiesRepository;
  const events: { outcome: string; reason: string | null }[] = [];
  const credentials = {
    listActiveFactors: vi.fn(async () =>
      Array.from({ length: world.factors ?? 0 }, (_, i) => ({
        id: `f${i}`,
        kind: 'totp',
        label: 'Phone',
      })),
    ),
    recordAuthenticationEvent: vi.fn(
      async (_r: unknown, e: { outcome: string; reason: string | null }) => {
        events.push(e);
      },
    ),
  } as unknown as CredentialsRepository;
  const accept = vi.fn(async () => ({}));
  const invitations: InvitationsPort = {
    preview: vi.fn(async () => {
      if (world.invitedEmail === undefined) throw new ApiError(404, 'not_found', 'Not found');
      return { inviteeEmail: world.invitedEmail };
    }),
    accept,
  };
  const createOwnerAccount = vi.fn(async () => ({
    userId: 'new-user',
    organizationId: 'new-org',
    slug: 'mona-s-workspace',
    organizationName: "Mona's workspace",
  }));
  const insertUser = vi.fn(async () => undefined);
  const service = new GoogleAuthService({
    database,
    credentials,
    invitations,
    signup:
      world.signupOpen === false
        ? null
        : ({ createOwnerAccount } as unknown as PublicSignupService),
    sessionSecret: SECRET,
    identities,
    accounts: { insertUser } as unknown as SignupAccountsRepository,
    now: () => NOW * 1000,
  });
  return { service, link, accept, createOwnerAccount, insertUser, events, credentials };
}

const CLAIMS: GoogleClaims = {
  subject: 'google-sub-1',
  email: 'mona@example.com',
  name: 'Mona Adel',
};
const CONTEXT = { correlationId: CORR };
const flowOf = (intent: GoogleFlow['intent'], extra = {}) => newFlow(intent, extra, NOW);

describe('GoogleAuthService', () => {
  it('signs an existing account in by email and links the Google identity', async () => {
    const h = serviceFor({ byEmail: 'user-1' });
    await expect(h.service.complete(flowOf('sign-in'), CLAIMS, CONTEXT)).resolves.toEqual({
      kind: 'signed-in',
      userId: 'user-1',
      returnTo: '/organizations',
    });
    expect(h.link).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', subject: 'google-sub-1' }),
    );
  });

  it('never creates an account from the sign-in page', async () => {
    const h = serviceFor({});
    await expect(h.service.complete(flowOf('sign-in'), CLAIMS, CONTEXT)).resolves.toEqual({
      kind: 'refused',
      reason: 'no_account',
    });
    expect(h.createOwnerAccount).not.toHaveBeenCalled();
    expect(h.insertUser).not.toHaveBeenCalled();
  });

  it('still requires the second factor after Google when the account has MFA', async () => {
    const h = serviceFor({ bySubject: 'user-1', factors: 1 });
    const outcome = await h.service.complete(flowOf('sign-in'), CLAIMS, CONTEXT);
    expect(outcome.kind).toBe('mfa');
    if (outcome.kind === 'mfa')
      expect(outcome.pending.challengeToken).toMatch(/^c1\.mfa\.user-1\./u);
  });

  it('sign-up creates the user and a new organization only while PUBLIC_SIGNUP is on', async () => {
    const open = serviceFor({});
    await expect(open.service.complete(flowOf('sign-up'), CLAIMS, CONTEXT)).resolves.toMatchObject({
      kind: 'signed-in',
      userId: 'new-user',
      returnTo: '/mona-s-workspace/home',
    });
    expect(open.createOwnerAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'mona@example.com',
        passwordHash: null,
        emailVerified: true,
      }),
    );

    const closed = serviceFor({ signupOpen: false });
    await expect(closed.service.complete(flowOf('sign-up'), CLAIMS, CONTEXT)).resolves.toEqual({
      kind: 'refused',
      reason: 'signup_closed',
    });
  });

  it('refuses an invitation when the Google email is not the invited email', async () => {
    const h = serviceFor({ invitedEmail: 'sara@northstar.studio' });
    await expect(
      h.service.complete(flowOf('invitation', { invitationToken: INVITE_TOKEN }), CLAIMS, CONTEXT),
    ).resolves.toEqual({ kind: 'refused', reason: 'email_mismatch' });
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.insertUser).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(
      expect.objectContaining({ outcome: 'failed', reason: 'google_email_mismatch' }),
    );
  });

  it('creates the invited account for the invited address and accepts the invitation', async () => {
    const h = serviceFor({ invitedEmail: 'Mona@example.com' });
    const outcome = await h.service.complete(
      flowOf('invitation', { invitationToken: INVITE_TOKEN }),
      CLAIMS,
      CONTEXT,
    );
    expect(outcome.kind).toBe('signed-in');
    expect(h.insertUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'Mona@example.com', emailVerified: true }),
    );
    expect(h.accept).toHaveBeenCalledWith(INVITE_TOKEN, expect.any(String), CORR);
  });
});

// ── the callback ─────────────────────────────────────────────────────────────

function controllerFor(world: World = { byEmail: 'user-1' }) {
  const exchangeCode = vi.fn(async () => ({ idToken: idToken() }));
  const transport: GoogleTransport = { exchangeCode, signingKeys: vi.fn(async () => [JWK]) };
  const start = vi.fn(async () => ({
    cookies: ['tm_access=a; HttpOnly'],
    csrfToken: 'c',
    expiresAt: new Date(),
  }));
  const options: GoogleAuthOptions = {
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    webPublicUrl: 'https://tmanage.example',
    sessionSecret: SECRET,
    secureCookies: true,
  };
  const { service } = serviceFor(world);
  const controller = new GoogleAuthController(
    service,
    { start } as unknown as SessionService,
    transport,
    options,
    () => true,
  );
  return { controller, exchangeCode, start };
}

describe('Google never merges into an unverified pre-registered account (wave 9 S6, F03)', () => {
  // The audit's exploit: someone signs up with a password for the victim's address (no mailbox
  // proof, email_verified_at NULL), then the victim uses "Continue with Google".
  const PRE_REGISTERED: World = { byEmail: 'attacker-account', byEmailVerified: false };

  it('sign-in: refused as unverified_account, nothing linked, no session, a failed event', async () => {
    const h = serviceFor(PRE_REGISTERED);
    await expect(h.service.complete(flowOf('sign-in'), CLAIMS, CONTEXT)).resolves.toEqual({
      kind: 'refused',
      reason: 'unverified_account',
    });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.credentials.listActiveFactors).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(
      expect.objectContaining({ outcome: 'failed', reason: 'google_unverified_account' }),
    );
    expect(h.events).not.toContainEqual(expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('sign-up: refused the same way, and no second account or organization is made', async () => {
    const h = serviceFor(PRE_REGISTERED);
    await expect(h.service.complete(flowOf('sign-up'), CLAIMS, CONTEXT)).resolves.toEqual({
      kind: 'refused',
      reason: 'unverified_account',
    });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.createOwnerAccount).not.toHaveBeenCalled();
  });

  it('invitation: refused, nothing linked, the invitation is NOT accepted for that account', async () => {
    const h = serviceFor({ ...PRE_REGISTERED, invitedEmail: 'mona@example.com' });
    await expect(
      h.service.complete(flowOf('invitation', { invitationToken: INVITE_TOKEN }), CLAIMS, CONTEXT),
    ).resolves.toEqual({ kind: 'refused', reason: 'unverified_account' });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.insertUser).not.toHaveBeenCalled();
  });

  it('a verified account with that address still links and signs in, and accepts invitations', async () => {
    const signIn = serviceFor({ byEmail: 'user-1', byEmailVerified: true });
    await expect(signIn.service.complete(flowOf('sign-in'), CLAIMS, CONTEXT)).resolves.toEqual({
      kind: 'signed-in',
      userId: 'user-1',
      returnTo: '/organizations',
    });
    expect(signIn.link).toHaveBeenCalledTimes(1);

    const invite = serviceFor({
      byEmail: 'user-1',
      byEmailVerified: true,
      invitedEmail: 'mona@example.com',
    });
    const outcome = await invite.service.complete(
      flowOf('invitation', { invitationToken: INVITE_TOKEN }),
      CLAIMS,
      CONTEXT,
    );
    expect(outcome).toMatchObject({ kind: 'signed-in', userId: 'user-1' });
    expect(invite.accept).toHaveBeenCalledWith(INVITE_TOKEN, 'user-1', CORR);
  });

  it('an identity already linked by subject is unaffected (it was linked while verified)', async () => {
    const h = serviceFor({ bySubject: 'user-1', byEmail: 'user-1', byEmailVerified: false });
    await expect(h.service.complete(flowOf('sign-in'), CLAIMS, CONTEXT)).resolves.toMatchObject({
      kind: 'signed-in',
      userId: 'user-1',
    });
  });

  it('the callback sends the person back with google_error=unverified_account and no session', async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    try {
      const signIn = controllerFor(PRE_REGISTERED);
      const flow = { ...newFlow('sign-in'), nonce: 'nonce-1' };
      const result = await signIn.controller.callback(
        { state: flow.state, code: 'c' },
        requestWith(flow),
        { header: vi.fn() },
      );
      expect(result.url).toBe('/sign-in?google_error=unverified_account');
      expect(signIn.start).not.toHaveBeenCalled();

      const invite = controllerFor({ ...PRE_REGISTERED, invitedEmail: 'mona@example.com' });
      const inviteFlow = {
        ...newFlow('invitation', { invitationToken: INVITE_TOKEN }),
        nonce: 'nonce-1',
      };
      const invited = await invite.controller.callback(
        { state: inviteFlow.state, code: 'c' },
        requestWith(inviteFlow),
        { header: vi.fn() },
      );
      expect(invited.url).toBe(`/invitations/${INVITE_TOKEN}?google_error=unverified_account`);
      expect(invite.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function requestWith(flow: GoogleFlow | null) {
  const request = {
    headers: (flow ? { cookie: `${GOOGLE_FLOW_COOKIE}=${sealFlow(flow, SECRET)}` } : {}) as Record<
      string,
      string
    >,
    ip: '203.0.113.5',
  };
  ensureRequestState(request);
  return request;
}

describe('GoogleAuthController callback', () => {
  it('a bad state is refused before the code is exchanged', async () => {
    const h = controllerFor();
    const flow = newFlow('sign-in');
    const reply = { header: vi.fn() };
    const result = await h.controller.callback(
      { state: 'not-the-state', code: 'c' },
      requestWith(flow),
      reply,
    );
    expect(result.url).toBe('/sign-in?google_error=state');
    expect(h.exchangeCode).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();

    const noCookie = await h.controller.callback(
      { state: flow.state, code: 'c' },
      requestWith(null),
      reply,
    );
    expect(noCookie.url).toBe('/sign-in?google_error=state');
  });

  it('a token whose nonce is not this browser’s is refused', async () => {
    const h = controllerFor();
    vi.useFakeTimers({ now: NOW * 1000 });
    try {
      const flow = newFlow('sign-in'); // its nonce is random, the token's is 'nonce-1'
      const result = await h.controller.callback(
        { state: flow.state, code: 'c' },
        requestWith(flow),
        {
          header: vi.fn(),
        },
      );
      expect(result.url).toBe('/sign-in?google_error=token');
      expect(h.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a good callback starts the session and redirects into the app', async () => {
    const h = controllerFor();
    vi.useFakeTimers({ now: NOW * 1000 });
    try {
      const flow = { ...newFlow('sign-in'), nonce: 'nonce-1' };
      const reply = { header: vi.fn() };
      const result = await h.controller.callback(
        { state: flow.state, code: 'c' },
        requestWith(flow),
        reply,
      );
      expect(result).toEqual({ url: '/organizations', statusCode: 302 });
      expect(h.exchangeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUri: 'https://tmanage.example/v1/auth/google/callback',
          verifier: flow.verifier,
        }),
      );
      expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
    } finally {
      vi.useRealTimers();
    }
  });
});
