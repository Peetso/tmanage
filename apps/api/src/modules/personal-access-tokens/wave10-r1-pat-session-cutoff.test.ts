import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonalAccessTokenRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import type { SessionState, SessionsRepository } from '../identity/sessions.repository.js';
import { PersonalAccessTokensController } from './personal-access-tokens.controller.js';
import type { PersonalAccessTokensRepository } from './personal-access-tokens.repository.js';
import { PersonalAccessTokensService } from './personal-access-tokens.service.js';

/**
 * Wave 10, lane R1 — N04 (security audit run 2), the personal-access-token half.
 *
 * The exploit: a create whose session passed the guard before a password reset, and whose insert
 * committed after the reset's second bearer-cutoff pass, left a live token behind the recovery.
 * Now the service re-reads the creating session after the insert and, if it ended, revokes the
 * new row and answers 401 `session_revoked`. Fakes only; the race is replayed by having the
 * session read return a revoked row, which is what the creator sees when the reset won.
 */

const ORG = '0198f4a2-1c00-7000-8000-00000000000a';
const MEMBERSHIP = '0198f4a2-1c00-7000-8000-00000000000b';
const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const SESSION = '0198f4a2-1c00-7000-8000-00000000000e';
const TOKEN_ID = '0198f4a2-1c00-7000-8000-00000000000f';

const CONTEXT = {
  organizationId: ORG,
  userId: USER,
  correlationId: '0198f4a2-1c00-7000-8000-00000000000d',
} as unknown as TenantContext;
const PRINCIPAL = { userId: USER, organizationId: ORG, membershipId: MEMBERSHIP } as Principal;

function sessionRow(overrides: { revokedAt?: Date | null; userId?: string } = {}): SessionState {
  return {
    session: {
      id: SESSION,
      userId: overrides.userId ?? USER,
      revokedAt: overrides.revokedAt ?? null,
    },
    expired: false,
  } as unknown as SessionState;
}

function harness(session: SessionState | null) {
  const insertedRow = {
    id: TOKEN_ID,
    name: 'laptop',
    tokenPrefix: 'tmanage_pat_abcd',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-10-26T10:00:00.000Z'),
  } as unknown as PersonalAccessTokenRow;
  const order: string[] = [];
  const database = {
    transaction: vi.fn(async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({})),
    identityRead: vi.fn(async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({})),
  } as unknown as TenantDatabase;
  const tokens = {
    insert: vi.fn(async () => {
      order.push('insert');
      return insertedRow;
    }),
    revoke: vi.fn(async () => {
      order.push('revoke');
      return 1;
    }),
  };
  const sessions = {
    findById: vi.fn(async () => {
      order.push('findById');
      return session;
    }),
  };
  const service = new PersonalAccessTokensService(
    database,
    tokens as unknown as PersonalAccessTokensRepository,
    sessions as unknown as SessionsRepository,
    // R13 s3: no stored policy — the defaults apply.
    { find: vi.fn(async () => undefined) },
    undefined,
    // R14 b: the audit rows land in the same order log.
    { append: vi.fn(async (_tx, _c, row: { action: string }) => order.push(row.action)) } as never,
  );
  return { service, tokens, sessions, order };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('N04 — a token minted while a recovery ends the session does not survive it', () => {
  it('session revoked between the guard and the insert: 401 session_revoked, the new token is revoked', async () => {
    const { service, tokens, sessions, order } = harness(
      sessionRow({ revokedAt: new Date('2026-10-26T10:00:00.000Z') }),
    );
    const error = await refusal(
      service.create(CONTEXT, PRINCIPAL, { name: 'laptop', sessionId: SESSION }),
    );
    expect(error.status).toBe(401);
    expect(error.auditCode).toBe('session_revoked');
    // The re-read happens after the insert, and the row it revokes is the one just inserted.
    // R14 b: the create and the revoke each leave an audit row in their own transaction.
    expect(order).toEqual([
      'insert',
      'personal_access_token.created',
      'findById',
      'revoke',
      'personal_access_token.revoked',
    ]);
    expect(sessions.findById).toHaveBeenCalledWith({}, SESSION);
    expect(tokens.revoke).toHaveBeenCalledWith({}, CONTEXT, MEMBERSHIP, TOKEN_ID, expect.any(Date));
  });

  it('a missing, expired or foreign session is treated the same way', async () => {
    const expired = { ...sessionRow(), expired: true } as SessionState;
    for (const state of [null, expired, sessionRow({ userId: 'someone-else' })]) {
      const { service, tokens } = harness(state);
      const error = await refusal(
        service.create(CONTEXT, PRINCIPAL, { name: 'laptop', sessionId: SESSION }),
      );
      expect(error.status).toBe(401);
      expect(tokens.revoke).toHaveBeenCalledOnce();
    }
  });

  it('a create with no session id is refused before anything is minted', async () => {
    const { service, tokens } = harness(sessionRow());
    const error = await refusal(service.create(CONTEXT, PRINCIPAL, { name: 'laptop' }));
    expect(error.status).toBe(401);
    expect(tokens.insert).not.toHaveBeenCalled();
  });

  it('a live session still creates the token exactly as before', async () => {
    const { service, tokens } = harness(sessionRow());
    const created = await service.create(CONTEXT, PRINCIPAL, {
      name: 'laptop',
      sessionId: SESSION,
    });
    expect(created.id).toBe(TOKEN_ID);
    expect(created.revokedAt).toBeNull();
    expect(created.token.length).toBeGreaterThan(0);
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  it('the controller hands the cookie session id to the service', async () => {
    const create = vi.fn(async () => ({ id: TOKEN_ID, token: 'tmanage_pat_x' }));
    const controller = new PersonalAccessTokensController({
      create,
    } as unknown as PersonalAccessTokensService);
    await controller.create(CONTEXT, PRINCIPAL, { name: 'laptop' }, 'cookie', {
      sessionId: SESSION,
      userId: USER,
    });
    // R13 s3: an absent expiry is `undefined` (the 90-day default), no longer `null` (never).
    expect(create).toHaveBeenCalledWith(CONTEXT, PRINCIPAL, {
      name: 'laptop',
      expiresInDays: undefined,
      sessionId: SESSION,
    });
  });
});
