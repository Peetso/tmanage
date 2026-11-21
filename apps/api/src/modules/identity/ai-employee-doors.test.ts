import { describe, expect, it, vi } from 'vitest';
import { aiEmployeeEmail } from '@tmanage/domain';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import { UserIdentitiesRepository } from '../google-auth/user-identities.repository.js';
import { PasswordResetService } from './password-reset.service.js';
import type { PasswordResetRepository } from './password-reset.repository.js';
import { SessionNotAuthenticatedError, SessionService } from './session.service.js';
import { signAccessToken } from './session-token.js';
import type { AccountStanding, SessionsRepository } from './sessions.repository.js';

/**
 * 60-04 (plan 60 v2 §4.1, security test 1) — the identity doors an AI employee's user never
 * passes, with fakes (IP-14). Rules: SE-2 (session validity has one owner, `SessionService`),
 * AR-8 (the address decision is the domain's `isAiEmployeeEmail`). The SQL-level doors (SCIM
 * visibility, the password writer, approver candidates, role writes, offboarding) are
 * `apps/api/test/t-60-04-ai-employee-doors.db.test.ts` (test phase).
 */

const SECRET = 'local_dev_only_session_secret_value_for_ai_doors_test';
const SESSION = '018f4b1e-6e4a-7c3d-9f21-2b7c5d8e9a11';
const USER = '018f4b1e-6e4a-7c3d-9f21-2b7c5d8e9a12';
const RUNNER = {} as IdentityQueryRunner;
const AI_EMAIL = aiEmployeeEmail(USER);

function sessionService(standing: AccountStanding) {
  const create = vi.fn(async () => ({ id: SESSION, userId: USER, expiresAt: new Date() }));
  const repository = {
    findById: async () => ({
      session: { id: SESSION, userId: USER, revokedAt: null, ipLast: null },
      expired: false,
    }),
    findStanding: async () => standing,
    create,
  } as unknown as SessionsRepository;
  const database = {
    identityRead: <T>(_o: unknown, work: (db: IdentityQueryRunner) => Promise<T>) => work(RUNNER),
    identityTransaction: <T>(_o: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
      work(RUNNER),
  } as unknown as TenantDatabase;
  const service = new SessionService(
    database,
    {
      cookieName: 'tm',
      sessionSecret: SECRET,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 86_400,
      refreshCookiePath: '/v1/auth/refresh',
      secureCookies: false,
      csrfSecret: 'local_dev_only_csrf_secret_value_for_ai_doors_test',
      csrfCookieName: 'tm_csrf',
    },
    repository,
  );
  return { service, create };
}

const AI: AccountStanding = { disabledAt: null, twoStepRequiredAt: null, aiEmployee: true };

describe('no session for an AI employee, by any sign-in', () => {
  it('start refuses with 403 before any session row is written', async () => {
    const { service, create } = sessionService(AI);
    await expect(service.start({ userId: USER, correlationId: 'c1' })).rejects.toMatchObject({
      status: 403,
      auditCode: 'ai_employee:sign_in',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('a person still starts a session', async () => {
    const { service, create } = sessionService({ disabledAt: null, twoStepRequiredAt: null });
    await service.start({ userId: USER, correlationId: 'c1' }).catch(() => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a session that somehow exists is refused at every request', async () => {
    const { service } = sessionService(AI);
    const accessToken = signAccessToken(
      { sessionId: SESSION, expiresAt: new Date(Date.now() + 600_000) },
      SECRET,
    );
    const refusal = await service
      .authenticate({ accessToken, correlationId: 'c1' })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(SessionNotAuthenticatedError);
    expect(refusal).toMatchObject({ code: 'ai_employee' });
  });
});

describe('no reset link for an AI employee', () => {
  it('answers like an unknown address, without a read or a mail', async () => {
    const identityTransaction = vi.fn();
    const deliver = vi.fn();
    const service = new PasswordResetService(
      { identityTransaction } as unknown as TenantDatabase,
      { deliver } as never,
      {} as PasswordResetRepository,
    );
    const result = await service.request(AI_EMAIL.toUpperCase(), {
      correlationId: 'c1',
    } as never);
    await expect(result.delivery).resolves.toBe('none');
    expect(identityTransaction).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('Google, Microsoft and company sign-in find no AI employee', () => {
  it('the address lookup is "no account" without touching the database', async () => {
    const runner = {
      query: vi.fn(() => {
        throw new Error('must not query');
      }),
    } as unknown as IdentityQueryRunner;
    await expect(
      new UserIdentitiesRepository().findUserByEmail(runner, ` ${AI_EMAIL.toUpperCase()} `),
    ).resolves.toBeNull();
  });
});
