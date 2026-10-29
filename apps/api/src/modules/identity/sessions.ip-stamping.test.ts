import { describe, expect, it, vi } from 'vitest';
import { SessionNotAuthenticatedError, SessionService } from './session.service.js';
import { signAccessToken } from './session-token.js';
import { storableIp } from './sessions.repository.js';
import type { AccountStanding, SessionsRepository } from './sessions.repository.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Platform admin v2 · PA-06 (0247) — `sessions.ip_first` / `ip_last`.
 *
 * The session check stamps the request's address only when it differs from the stored
 * `ip_last`, in its own write so an ordinary request costs nothing; a failed stamp never
 * refuses a live session. A disabled account's session is refused like a dead one.
 */

const SECRET = 'local_dev_only_session_secret_value_for_ip_stamping';
const SESSION = '018f4b1e-6e4a-7c3d-9f21-2b7c5d8e9a01';
const USER = '018f4b1e-6e4a-7c3d-9f21-2b7c5d8e9a02';
const RUNNER = {} as IdentityQueryRunner;

function setup(options: {
  ipLast: string | null;
  standing?: AccountStanding;
  stampFails?: boolean;
}) {
  const stampAddress = vi.fn(async () => {
    if (options.stampFails) throw new Error('lock wait timeout');
  });
  const repository = {
    findById: async () => ({
      session: { id: SESSION, userId: USER, revokedAt: null, ipLast: options.ipLast },
      expired: false,
    }),
    findStanding: async () => options.standing ?? { disabledAt: null, twoStepRequiredAt: null },
    stampAddress,
  } as unknown as SessionsRepository;
  const transactions: string[][] = [];
  const database = {
    identityRead: <T>(_o: unknown, work: (db: IdentityQueryRunner) => Promise<T>) => work(RUNNER),
    identityTransaction: <T>(
      o: { tables: string[] },
      work: (tx: IdentityQueryRunner) => Promise<T>,
    ) => {
      transactions.push(o.tables);
      return work(RUNNER);
    },
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
      csrfSecret: 'local_dev_only_csrf_secret_value_for_ip_stamping',
      csrfCookieName: 'tm_csrf',
    },
    repository,
  );
  const accessToken = signAccessToken(
    { sessionId: SESSION, expiresAt: new Date(Date.now() + 600_000) },
    SECRET,
  );
  return { service, stampAddress, transactions, accessToken };
}

describe('storableIp', () => {
  it('keeps an IPv4 or IPv6 text form, trims it, refuses empty and over-long input', () => {
    expect(storableIp(' 41.33.10.8 ')).toBe('41.33.10.8');
    expect(storableIp('2001:db8::1')).toBe('2001:db8::1');
    expect(storableIp('')).toBeNull();
    expect(storableIp(undefined)).toBeNull();
    expect(storableIp('x'.repeat(46))).toBeNull();
  });
});

describe('session check address stamping (PA-06)', () => {
  it('stamps a new address in its own sessions-only write', async () => {
    const { service, stampAddress, transactions, accessToken } = setup({ ipLast: '10.0.0.1' });
    await expect(
      service.authenticate({ accessToken, correlationId: 'c1', ip: '41.33.10.8' }),
    ).resolves.toEqual({ sessionId: SESSION, userId: USER, twoStepRequired: false });
    expect(stampAddress).toHaveBeenCalledWith(RUNNER, SESSION, '41.33.10.8');
    expect(transactions).toEqual([['sessions']]);
  });

  it('writes nothing when the address has not moved, or there is none', async () => {
    const same = setup({ ipLast: '41.33.10.8' });
    await same.service.authenticate({
      accessToken: same.accessToken,
      correlationId: 'c1',
      ip: '41.33.10.8',
    });
    expect(same.stampAddress).not.toHaveBeenCalled();

    const none = setup({ ipLast: null });
    await none.service.authenticate({ accessToken: none.accessToken, correlationId: 'c1' });
    expect(none.stampAddress).not.toHaveBeenCalled();
  });

  it('a failed stamp never refuses the live session', async () => {
    const { service, accessToken } = setup({ ipLast: null, stampFails: true });
    await expect(
      service.authenticate({ accessToken, correlationId: 'c1', ip: '41.33.10.8' }),
    ).resolves.toMatchObject({ sessionId: SESSION });
  });

  it('a disabled account is refused account_disabled; two-step required is reported', async () => {
    const disabled = setup({
      ipLast: null,
      standing: { disabledAt: new Date(), twoStepRequiredAt: null },
    });
    await expect(
      disabled.service.authenticate({ accessToken: disabled.accessToken, correlationId: 'c1' }),
    ).rejects.toEqual(new SessionNotAuthenticatedError('account_disabled'));

    const required = setup({
      ipLast: null,
      standing: { disabledAt: null, twoStepRequiredAt: new Date() },
    });
    await expect(
      required.service.authenticate({ accessToken: required.accessToken, correlationId: 'c1' }),
    ).resolves.toMatchObject({ twoStepRequired: true });
  });
});
