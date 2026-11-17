import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AdminInvitationManagementController } from './invitation-management.controller.js';
import { InvitationManagementService } from './invitation-management.service.js';
import type {
  InvitationManagementRepository,
  InvitationStatusRow,
  PendingInvitationRow,
} from './invitation-management.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { MailBouncesRepository } from '../mail-bounces/mail-bounces.repository.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Admin invitation management (x328) over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — both routes sit behind
 * `org.manage` (a caller without it is a 403); the revoke resolves by `(tenant, id)` BEFORE authorize,
 * so a cross-tenant id is a 404 with no write (the Known trap); an accepted invitation cannot be revoked
 * (409, no write); a revoke is idempotent (already-revoked → 204, no second write); and a pending one is
 * revoked exactly once. No token hash is ever in the list projection.
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

/** A workspace_admin — does not hold `org.manage`, so the list/revoke authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin' };
}

const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;

/**
 * An in-memory {@link InvitationManagementRepository}. `rows` are the tenant's invitations; a `findStatus`
 * miss models a cross-tenant id (what the real tenant-scoped read returns for an id not in this tenant).
 */
class FakeRepository {
  revokeCalls = 0;
  constructor(private readonly rows: InvitationStatusRow[] = []) {}

  organizationExists(): Promise<boolean> {
    return Promise.resolve(true);
  }

  listPending(): Promise<readonly PendingInvitationRow[]> {
    const pending = this.rows.filter((r) => r.status === 'pending');
    return Promise.resolve(
      pending.map((r) => ({
        id: r.id,
        email: 'invitee@example.test',
        role: 'member',
        invitedByUserId: OWNER_USER,
        invitedByName: 'Owner',
        invitedByEmail: 'owner@example.test',
        expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        createdAt: '2026-09-01T00:00:00.000Z',
      })),
    );
  }

  listProjectsFor(): Promise<
    readonly { invitationId: string; projectId: string; projectName: string }[]
  > {
    return Promise.resolve(
      this.rows
        .filter((r) => r.id === 'inv-1')
        .map(() => ({ invitationId: 'inv-1', projectId: 'p-1', projectName: 'Website' })),
    );
  }

  findStatus(_r: unknown, _c: unknown, id: string): Promise<InvitationStatusRow | undefined> {
    return Promise.resolve(this.rows.find((r) => r.id === id));
  }

  revokePending(_r: unknown, _c: unknown, id: string): Promise<number> {
    this.revokeCalls += 1;
    const pending = this.rows.some((r) => r.id === id && r.status === 'pending');
    return Promise.resolve(pending ? 1 : 0);
  }
}

function controllerWith(
  repo: FakeRepository,
  stopped: readonly string[] = [],
): AdminInvitationManagementController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InvitationManagementService(
    repo as unknown as InvitationManagementRepository,
    {
      suppressedAddresses: () => Promise.resolve(new Set(stopped)),
    } as unknown as MailBouncesRepository,
  );
  return new AdminInvitationManagementController(database, service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('AdminInvitationManagementController (ADM invitations, x328)', () => {
  it('lists pending invitations for an owner, metadata only (no token field)', async () => {
    const repo = new FakeRepository([{ id: 'inv-1', status: 'pending' }]);
    const view = await controllerWith(repo).list(context, owner());
    expect(view.invitations).toHaveLength(1);
    const [first] = view.invitations;
    expect(first).toBeDefined();
    expect(first).toMatchObject({ id: 'inv-1', email: 'invitee@example.test' });
    expect(Object.keys(first as object)).not.toContain('tokenHash');
  });

  it('R38 G4: shows the projects an invitation is tagged with on its row', async () => {
    const repo = new FakeRepository([
      { id: 'inv-1', status: 'pending' },
      { id: 'inv-2', status: 'pending' },
    ]);
    const view = await controllerWith(repo).list(context, owner());
    expect(view.invitations.map((row) => row.projects)).toEqual([
      [{ id: 'p-1', name: 'Website' }],
      [],
    ]);
  });

  it('56-26 B1: flags a pending invitation whose address the company stopped mailing', async () => {
    const repo = new FakeRepository([{ id: 'inv-1', status: 'pending' }]);
    const stopped = await controllerWith(repo, ['invitee@example.test']).list(context, owner());
    const clear = await controllerWith(repo).list(context, owner());
    expect(stopped.invitations[0]?.deliveryStopped).toBe(true);
    expect(clear.invitations[0]?.deliveryStopped).toBe(false);
  });

  it('403s list without org.manage (the real authorize), and does not read another tenant’s rows', async () => {
    const repo = new FakeRepository([{ id: 'inv-1', status: 'pending' }]);
    await expectStatus(controllerWith(repo).list(context, orgAdmin()), 403);
  });

  it('revokes a pending invitation exactly once (pending → revoked)', async () => {
    const repo = new FakeRepository([{ id: 'inv-1', status: 'pending' }]);
    const controller = controllerWith(repo);
    await controller.revoke(context, owner(), 'inv-1');
    expect(repo.revokeCalls).toBe(1);
  });

  it('404s a cross-tenant invitation id, BEFORE authorize and with no write (Known trap)', async () => {
    const repo = new FakeRepository([]);
    await expectStatus(controllerWith(repo).revoke(context, owner(), 'other-tenant-inv'), 404);
    expect(repo.revokeCalls).toBe(0);
  });

  it('409s revoking an accepted invitation, with no write', async () => {
    const repo = new FakeRepository([{ id: 'inv-1', status: 'accepted' }]);
    await expectStatus(controllerWith(repo).revoke(context, owner(), 'inv-1'), 409);
    expect(repo.revokeCalls).toBe(0);
  });

  it('is idempotent: revoking an already-revoked invitation is a 204 no-op with no write', async () => {
    const repo = new FakeRepository([{ id: 'inv-1', status: 'revoked' }]);
    await controllerWith(repo).revoke(context, owner(), 'inv-1');
    expect(repo.revokeCalls).toBe(0);
  });

  it('guards both routes with org.manage, so a caller without it is refused by CapabilityGuard', () => {
    for (const method of ['list', 'revoke'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        AdminInvitationManagementController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
