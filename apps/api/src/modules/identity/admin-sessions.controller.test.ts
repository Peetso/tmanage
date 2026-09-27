import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AdminSessionsController } from './admin-sessions.controller.js';
import { AdminSessionsService } from './admin-sessions.service.js';
import type {
  AdminSessionsRepository,
  AdminSessionRow,
  OrgMemberRow,
} from './admin-sessions.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Admin session visibility + revocation (x223) over fakes, with the **real** `authorize`.
 *
 * The database and the drizzle queries are faked, but the policy is not: a real `Principal`
 * runs through the real evaluator, so these cases prove the slice's safety — the list is
 * metadata only (no token material); a revoke soft-closes a member's session and a re-revoke is
 * an idempotent no-op; a session owned by no member of the caller's organization is a 404 with
 * no write BEFORE the authorize (the Known trap); and both routes sit behind `org.manage`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: OWNER_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** An org_admin — holds every capability except `org.manage`, so the real authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

const context = {
  organizationId: ORG,
  correlationId: 'test-correlation',
} as unknown as TenantContext;

function member(userId: string, membershipId: string, displayName: string): OrgMemberRow {
  return { userId, membershipId, displayName };
}

function sessionRow(id: string, userId: string): AdminSessionRow {
  return {
    id,
    userId,
    userAgent: 'Mozilla/5.0 (Test)',
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
    rotatedAt: null,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
  };
}

/**
 * An in-memory {@link AdminSessionsRepository}. `listActiveForUsers` returns only live sessions
 * for the given member ids, exactly what the real scoped read gives; `revoke` flips a live row
 * to revoked and is naturally idempotent (a revoked row stays revoked).
 */
class FakeRepository {
  revokeCalls = 0;
  private readonly revoked = new Set<string>();

  constructor(
    readonly members: OrgMemberRow[] = [],
    readonly rows: AdminSessionRow[] = [],
  ) {}

  listOrgMembers(): Promise<readonly OrgMemberRow[]> {
    return Promise.resolve(this.members);
  }

  listActiveForUsers(_r: unknown, userIds: readonly string[]): Promise<readonly AdminSessionRow[]> {
    const set = new Set(userIds);
    return Promise.resolve(
      this.rows.filter((row) => set.has(row.userId) && !this.revoked.has(row.id)),
    );
  }

  findSessionUserId(_r: unknown, sessionId: string): Promise<string | null> {
    return Promise.resolve(this.rows.find((row) => row.id === sessionId)?.userId ?? null);
  }

  revoke(_r: unknown, sessionId: string): Promise<void> {
    this.revokeCalls += 1;
    this.revoked.add(sessionId);
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeRepository): AdminSessionsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    identityRead: async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    identityTransaction: async (_o: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new AdminSessionsService(database, repo as unknown as AdminSessionsRepository);
  return new AdminSessionsController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

const TOKEN_FIELDS = ['refreshTokenHash', 'refresh_token_hash', 'token', 'tokenHash', 'secret'];

describe('AdminSessionsController (ADM active sessions + revocation, x223)', () => {
  it("lists members' live sessions as metadata only — no token material", async () => {
    const repo = new FakeRepository(
      [member('user-a', 'm-a', 'Ada'), member('user-b', 'm-b', 'Bea')],
      [sessionRow('s-a', 'user-a'), sessionRow('s-b', 'user-b'), sessionRow('s-x', 'stranger')],
    );
    const { sessions } = await controllerWith(repo).list(context, owner());

    // Only the two members' sessions surface; the stranger's is invisible.
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s-a', 's-b']);
    expect(sessions.find((s) => s.sessionId === 's-a')?.memberName).toBe('Ada');
    // The projection carries no credential material of any kind.
    for (const entry of sessions) {
      for (const field of TOKEN_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(entry, field)).toBe(false);
      }
    }
  });

  it('soft-closes a member session, and a re-revoke is an idempotent no-op', async () => {
    const repo = new FakeRepository(
      [member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-a', 'user-a')],
    );
    const controller = controllerWith(repo);

    expect(await controller.revoke(context, owner(), 's-a')).toEqual({ revoked: true });
    // The session is now gone from the live list — a soft-close, and it is no longer surfaced.
    expect((await controller.list(context, owner())).sessions).toHaveLength(0);
    // A second revoke still answers 200 and never errors.
    expect(await controller.revoke(context, owner(), 's-a')).toEqual({ revoked: true });
    expect(repo.revokeCalls).toBe(2);
  });

  it('answers 404 for a session owned by no member of this organization, without revoking', async () => {
    const repo = new FakeRepository(
      [member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-x', 'stranger')],
    );
    await expectStatus(controllerWith(repo).revoke(context, owner(), 's-x'), 404);
    // Also 404 for an id that does not exist at all — indistinguishable from cross-tenant.
    await expectStatus(controllerWith(repo).revoke(context, owner(), 's-missing'), 404);
    expect(repo.revokeCalls).toBe(0);
  });

  it('refuses a caller without org.manage — 403 on both routes, no write', async () => {
    const repo = new FakeRepository(
      [member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-a', 'user-a')],
    );
    await expectStatus(controllerWith(repo).list(context, orgAdmin()), 403);
    await expectStatus(controllerWith(repo).revoke(context, orgAdmin(), 's-a'), 403);
    expect(repo.revokeCalls).toBe(0);
  });
});
