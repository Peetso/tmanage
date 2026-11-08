import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { parseSeedKeys } from '@tmanage/config';
import { SIGN_IN_METHOD_OF_ACTION } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type {
  IdentityQueryRunner,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { TwoStepRequirementGuard } from '../../common/http/guards/two-step-requirement.guard.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { GoogleAuthService } from '../google-auth/google-auth.service.js';
import type { UserIdentitiesRepository } from '../google-auth/user-identities.repository.js';
import { newFlow } from '../google-auth/google-oidc.js';
import { AUTHENTICATION_ACTIONS, AuthenticationService } from './authentication.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import { hashPassword } from './password.js';
import { signReauthToken } from './reauth-token.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import type { SessionsRepository } from './sessions.repository.js';
import { decideSignInMethod } from './sign-in-policy.repository.js';
import type { SignInPolicyRepository } from './sign-in-policy.repository.js';
import { isStepUpFresh, SignInPolicyService } from './sign-in-policy.service.js';

/** 56-25 (R18-e) over fakes: the policy route, both sign-in paths, the guard and the census. */

const ORG = '01890000-0000-7000-8000-00000000000a';
const USER = '01890000-0000-7000-8000-000000000001';
const context = { organizationId: ORG, userId: USER, correlationId: 'c-1' } as TenantContext;
const admin = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as unknown as Principal;

function policyService(input: { stored?: unknown; without?: number; own?: string[] }) {
  const upsert = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const send = vi.fn(async () => 'sent' as const);
  const repository = {
    readDocument: vi.fn(async () => input.stored),
    countMembersWithout: vi.fn(async () => input.without ?? 0),
    listOwners: vi.fn(async () => [{ email: 'owner@acme.test', locale: 'ar' }]),
    listOwnMethods: vi.fn(async () => input.own ?? ['password']),
  } as unknown as SignInPolicyRepository;
  const database = {
    read: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
  } as unknown as TenantDatabase;
  const service = new SignInPolicyService(
    database,
    { record } as never,
    { send },
    repository,
    { upsert },
    () => new Date('2026-11-02T10:00:00.000Z'),
  );
  return { service, upsert, record, send };
}

describe('PUT …/security/sign-in-policy', () => {
  it('refuses a change that would lock members out (409 with the count) and writes nothing', async () => {
    const h = policyService({ without: 3 });
    const body = { allowedMethods: ['google'], requireTwoStepRoles: 'nobody' };
    await expect(h.service.update(context, admin, body, true)).rejects.toMatchObject({
      status: 409,
      code: 'members_without_method',
      details: [{ field: 'count', message: '3' }],
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('A16: only the owner may change it, and never off the last method the owner uses (409)', async () => {
    const h = policyService({ own: ['password'] });
    const body = { allowedMethods: ['google'], requireTwoStepRoles: 'nobody' };
    const orgAdmin = { ...admin, role: 'org_admin' } as unknown as Principal;
    await expect(h.service.update(context, orgAdmin, body, true)).rejects.toMatchObject({
      status: 403,
    });
    await expect(h.service.update(context, admin, body, true)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      details: [{ field: 'ownMethods', message: 'password' }],
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('refuses an empty method list (400) and a missing step-up (403)', async () => {
    const h = policyService({});
    await expect(
      h.service.update(context, admin, { allowedMethods: [], requireTwoStepRoles: 'nobody' }, true),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(
      h.service.update(context, admin, { allowedMethods: ['password'] }, false),
    ).rejects.toMatchObject({ status: 403, code: 'reauthentication_required' });
    const secret = 'local_dev_only_session_secret_for_the_sign_in_policy_test';
    const token = signReauthToken(
      { userId: USER, sessionId: 's-1', expiresAt: new Date(Date.now() + 60_000) },
      secret,
    );
    expect(isStepUpFresh({ token, secret, userId: USER, sessionId: 's-1' })).toBe(true);
    expect(isStepUpFresh({ token, secret, userId: USER, sessionId: 's-2' })).toBe(false);
  });

  it('merges the keys (other keys kept), starts a grace on tightening, audits and mails owners', async () => {
    const h = policyService({ stored: { session_max_hours: 12, 'pat.max_expiry_days': 30 } });
    const state = await h.service.update(
      context,
      admin,
      { allowedMethods: ['google', 'password'], requireTwoStepRoles: 'admins' },
      true,
    );
    expect(state).toMatchObject({
      allowedMethods: ['password', 'google'],
      requireTwoStepRoles: 'admins',
      graceUntil: '2026-11-16T10:00:00.000Z',
      sessionMaxHours: 12,
    });
    expect(h.upsert).toHaveBeenCalledWith({}, context, {
      policy: expect.objectContaining({
        'pat.max_expiry_days': 30,
        'signin.allowed_methods': ['password', 'google'],
        'security.two_step_grace_until': '2026-11-16T10:00:00.000Z',
      }),
      updatedBy: USER,
    });
    expect(h.record).toHaveBeenCalledWith(
      {},
      context,
      expect.objectContaining({ action: 'org.sign_in_policy_changed' }),
    );
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'owner@acme.test', templateKey: 'credential_change' }),
    );
  });
});

const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x22).toString('base64url')}`));
const PASSWORD = 'correct horse battery staple 42';
const refusal = { use: ['google' as const], organization: 'acme' };

describe('password sign-in under the policy', () => {
  it('is refused only after a correct password, with the reason recorded', async () => {
    const events: { reason: string | null }[] = [];
    const hash = await hashPassword(PASSWORD);
    const credentials = Object.assign(new CredentialsRepository(CIPHER), {
      findUserIdByEmail: async () => ({ id: USER, displayName: 'Maya' }),
      findPassword: async () => ({ userId: USER, passwordHash: hash }),
      countRecentFailures: async () => 0,
      listActiveFactors: async () => [],
      recordAuthenticationEvent: async (_r: unknown, e: { reason?: string | null }) => {
        events.push({ reason: e.reason ?? null });
      },
    }) as unknown as CredentialsRepository;
    const runner = {} as IdentityQueryRunner;
    const database = {
      identityRead: (_o: unknown, work: (db: IdentityQueryRunner) => unknown) => work(runner),
      identityTransaction: (_o: unknown, work: (tx: IdentityQueryRunner) => unknown) =>
        work(runner),
    } as unknown as TenantDatabase;
    const check = vi.fn(async () => refusal);
    const service = new AuthenticationService(
      database,
      {
        sessionSecret: 'local_dev_only_session_secret_for_the_sign_in_policy_test',
        maxFailuresInWindow: 5,
        failureWindowSeconds: 900,
        totpIssuer: 'TManage',
        abuseControl: createSignInAbuseControl({
          windowMs: 300_000,
          maxPerSource: 1_000,
          maxPerSourceAccount: 1_000,
          maxGlobal: 10_000,
        }),
        signInPolicy: { check },
      },
      credentials,
      Date.now,
      { findStanding: async () => null } as unknown as SessionsRepository,
    );
    const ctx = { correlationId: 'c-2', ip: null, userAgent: null };
    await expect(
      service.signInWithPassword({ email: 'maya@acme.test', password: 'wrong', context: ctx }),
    ).rejects.toMatchObject({ rejection: 'invalid_credentials' });
    expect(check).not.toHaveBeenCalled();
    await expect(
      service.signInWithPassword({ email: 'maya@acme.test', password: PASSWORD, context: ctx }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'method_not_allowed',
      details: [
        { field: 'use', message: 'google' },
        { field: 'organization', message: 'acme' },
      ],
    });
    expect(events.at(-1)).toEqual({ reason: 'policy_method_not_allowed' });
  });

  it('refuses only when every organization forbids the method; owners are exempt', () => {
    const forbids = { 'signin.allowed_methods': ['google'] };
    expect(
      decideSignInMethod([{ role: 'member', slug: 'a', policy: forbids }], 'password'),
    ).toEqual({ use: ['google'], organization: 'a' });
    expect(
      decideSignInMethod(
        [
          { role: 'member', slug: 'a', policy: forbids },
          { role: 'member', slug: 'b', policy: null },
        ],
        'password',
      ),
    ).toBeNull();
    expect(
      decideSignInMethod([{ role: 'owner', slug: 'a', policy: forbids }], 'password'),
    ).toBeNull();
  });
});

describe('Google sign-in under the policy', () => {
  it('is refused when google is not allowed, and the refusal is recorded', async () => {
    const events: (string | null)[] = [];
    const runner = {};
    const service = new GoogleAuthService({
      database: {
        identityTransaction: async (_o: unknown, work: (r: unknown) => unknown) => work(runner),
        identityRead: async (_o: unknown, work: (r: unknown) => unknown) => work(runner),
      } as unknown as TenantDatabase,
      credentials: {
        listActiveFactors: async () => [],
        recordAuthenticationEvent: async (_r: unknown, e: { reason: string | null }) => {
          events.push(e.reason);
        },
      } as unknown as CredentialsRepository,
      invitations: { preview: vi.fn(), accept: vi.fn() },
      signup: null,
      sessionSecret: 'local_dev_only_session_secret_for_the_sign_in_policy_test',
      identities: {
        findUserBySubject: async () => ({ userId: USER }),
        touch: async () => undefined,
      } as unknown as UserIdentitiesRepository,
      signInPolicy: { check: async () => ({ use: ['password'], organization: 'acme' }) },
    });
    const outcome = await service.complete(
      newFlow('sign-in', {}, Math.floor(Date.now() / 1000)),
      { subject: 'g-1', email: 'maya@acme.test', name: 'Maya' },
      { correlationId: 'c-3' },
    );
    expect(outcome).toEqual({ kind: 'refused', reason: 'method_not_allowed' });
    expect(events).toEqual(['policy_method_not_allowed']);
  });
});

describe('two-step by role', () => {
  function run(policy: unknown, role: string, enrolled: boolean) {
    const headers: Record<string, string> = {};
    const database = {
      read: async (_c: unknown, work: (r: unknown) => unknown) => work({}),
      identityRead: async () => enrolled,
    } as unknown as TenantDatabase;
    const guard = new TwoStepRequirementGuard(
      { getAllAndOverride: () => false } as never,
      database,
      { findByKey: async () => undefined } as unknown as OrgSettingsRepository,
      { readDocument: async () => policy } as unknown as SignInPolicyRepository,
    );
    const request = { url: '/v1/organizations/acme/projects', params: { orgSlug: 'acme' } };
    const state = requireRequestState(request);
    state.session = { sessionId: 's-1', userId: USER } as NonNullable<typeof state.session>;
    state.tenant = context;
    state.membership = { role } as NonNullable<typeof state.membership>;
    const execution = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ header: (n: string, v: string) => (headers[n] = v) }),
      }),
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(execution), headers };
  }
  const future = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();
  const admins = (grace: string) => ({
    'security.require_two_step_roles': 'admins',
    'security.two_step_grace_until': grace,
  });

  it("'admins' covers org_admin, not member; grace passes with the header, after it 403", async () => {
    await expect(run(admins(past), 'member', false).result).resolves.toBe(true);
    const inGrace = run(admins(future), 'org_admin', false);
    await expect(inGrace.result).resolves.toBe(true);
    expect(inGrace.headers['X-TManage-Two-Step-Grace']).toBe(future);
    await expect(run(admins(past), 'org_admin', false).result).rejects.toMatchObject({
      status: 403,
      code: 'two_step_required',
    });
    await expect(run(admins(past), 'owner', false).result).resolves.toBe(true);
  });

  it("'everyone' covers every internal role but no client", async () => {
    const everyone = { 'security.require_two_step_roles': 'everyone' };
    await expect(run(everyone, 'member', false).result).rejects.toMatchObject({ status: 403 });
    await expect(run(everyone, 'member', true).result).resolves.toBe(true);
    await expect(run(everyone, 'client_viewer', false).result).resolves.toBe(true);
  });
});

describe('the sign-in census', () => {
  it('every action in SIGN_IN_METHOD_OF_ACTION exists in the code, and every sign-in action is mapped', () => {
    const google = readFileSync(
      new URL('../google-auth/google-auth.service.ts', import.meta.url),
      'utf8',
    );
    const codeActions = new Set<string>([
      ...Object.values(AUTHENTICATION_ACTIONS),
      ...[...google.matchAll(/_SIGN_IN_ACTION = '([a-z_]+)'/gu)].map((m) => m[1] ?? ''),
    ]);
    for (const action of Object.keys(SIGN_IN_METHOD_OF_ACTION)) {
      expect(codeActions.has(action), action).toBe(true);
    }
    for (const action of [
      AUTHENTICATION_ACTIONS.passwordSignIn,
      AUTHENTICATION_ACTIONS.mfaChallenge,
      AUTHENTICATION_ACTIONS.recoveryCode,
      'google_sign_in',
    ]) {
      expect(action in SIGN_IN_METHOD_OF_ACTION, action).toBe(true);
    }
  });
});
