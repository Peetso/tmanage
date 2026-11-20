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
import type { SessionIntelReader } from './geo/session-intel.service.js';

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

/** A workspace_admin — does not hold `org.manage`, so the real authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin' };
}

const context = {
  organizationId: ORG,
  correlationId: 'test-correlation',
} as unknown as TenantContext;

function member(
  userId: string,
  membershipId: string,
  displayName: string,
  role = 'member',
): OrgMemberRow {
  return { userId, membershipId, displayName, role };
}

function sessionRow(id: string, userId: string): AdminSessionRow {
  return {
    id,
    userId,
    userAgent: 'Mozilla/5.0 (Test)',
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
    rotatedAt: null,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    ...{ ipFirst: null, ipLast: null, signInEventId: null },
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
    /** F42 (wave 9 S8): user ids that also hold access in another organization. */
    readonly elsewhere: readonly string[] = [],
  ) {}

  listUsersWithAccessElsewhere(
    _r: unknown,
    _org: string,
    userIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(userIds.filter((id) => this.elsewhere.includes(id))));
  }

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

function controllerWith(repo: FakeRepository, intel?: unknown): AdminSessionsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    identityRead: async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    identityTransaction: async (_o: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    bootstrapRead: async (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const typed = repo as unknown as AdminSessionsRepository;
  const service = new AdminSessionsService(database, typed, intel as SessionIntelReader);
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

describe('wave9-S8 F42 regression: org admins act only on single-organization members, never the owner', () => {
  /** An org_admin: holds `org.manage` (full ceiling) but is not the owner. */
  function admin(): Principal {
    return { ...owner(), role: 'org_admin' };
  }

  it('omits the sessions of a member who also belongs to another organization, and 404s their revoke', async () => {
    const repo = new FakeRepository(
      [member('user-v', 'm-v', 'Vic'), member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-v', 'user-v'), sessionRow('s-a', 'user-a')],
      ['user-v'],
    );
    const controller = controllerWith(repo);
    const { sessions } = await controller.list(context, owner());
    expect(sessions.map((s) => s.sessionId)).toEqual(['s-a']);
    // No device or activity metadata for the multi-organization member leaves this organization.
    expect(JSON.stringify(sessions)).not.toContain('s-v');
    await expectStatus(controller.revoke(context, owner(), 's-v'), 404);
    expect(repo.revokeCalls).toBe(0);
  });

  it('still lists and revokes a single-organization member', async () => {
    const repo = new FakeRepository(
      [member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-a', 'user-a')],
    );
    const controller = controllerWith(repo);
    expect((await controller.list(context, admin())).sessions).toHaveLength(1);
    expect(await controller.revoke(context, admin(), 's-a')).toEqual({ revoked: true });
    expect(repo.revokeCalls).toBe(1);
  });

  it("refuses an org_admin acting on the owner's session (403, no write) and hides it from their list", async () => {
    const repo = new FakeRepository(
      [member('user-o', 'm-o', 'Olu', 'owner'), member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-o', 'user-o'), sessionRow('s-a', 'user-a')],
    );
    const controller = controllerWith(repo);
    await expectStatus(controller.revoke(context, admin(), 's-o'), 403);
    expect(repo.revokeCalls).toBe(0);
    expect((await controller.list(context, admin())).sessions.map((s) => s.sessionId)).toEqual([
      's-a',
    ]);
    // The owner still sees and manages their own and everyone's sessions.
    expect((await controller.list(context, owner())).sessions).toHaveLength(2);
    expect(await controller.revoke(context, owner(), 's-o')).toEqual({ revoked: true });
  });

  it("QA-FIX-P S3: an org_admin can neither see nor end another org_admin's sessions", async () => {
    const repo = new FakeRepository(
      [member('user-b', 'm-b', 'Bea', 'org_admin'), member('user-a', 'm-a', 'Ada')],
      [sessionRow('s-b', 'user-b'), sessionRow('s-a', 'user-a')],
    );
    const controller = controllerWith(repo);
    await expectStatus(controller.revoke(context, admin(), 's-b'), 403);
    expect(repo.revokeCalls).toBe(0);
    expect((await controller.list(context, admin())).sessions.map((s) => s.sessionId)).toEqual([
      's-a',
    ]);
    expect(await controller.revoke(context, owner(), 's-b')).toEqual({ revoked: true });
  });
});

describe('R12 session trail CSV (admin)', () => {
  const repo = () =>
    new FakeRepository([member('user-a', 'm-a', 'Ada')], [sessionRow('s-a', 'user-a')]);
  const owners = new Map([
    ['s-a', 'user-a'],
    ['s-x', 'stranger'],
  ]);
  const intel = {
    sessionTrail: async (_c: string, id: string, mayRead: (owner: string) => boolean) =>
      owners.has(id) && mayRead(owners.get(id) as string) ? 'occurredAtUtc' : null,
  };
  it('downloads a member session as text/csv; another org or a non-admin is 404 / 403', async () => {
    const headers = new Map<string, string>();
    const reply = { header: (name: string, value: string) => headers.set(name, value) };
    await controllerWith(repo(), intel).trail(context, owner(), 's-a', reply);
    expect(headers.get('content-type')).toBe('text/csv; charset=utf-8');
    await expectStatus(controllerWith(repo(), intel).trail(context, owner(), 's-x', reply), 404);
    await expectStatus(controllerWith(repo(), intel).trail(context, orgAdmin(), 's-a', reply), 403);
  });
});
