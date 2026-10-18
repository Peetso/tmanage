import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AdminExportRequestsController } from './export-requests.controller.js';
import type { AdminExportRequestsRepository } from './export-requests.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AdminExportRequestRow, AdminExportScope } from '../../common/database/schema.js';

/**
 * Admin data-export requests (x224) create + list over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the organization is resolved
 * tenant-scoped BEFORE the org-wide `org.manage` authorize (a cross-tenant context is a 404 with no
 * write, the Known trap); the fixed `ADMIN_EXPORT_SCOPES` allowlist is the boundary (an unknown scope
 * is a 400 with no write); a request is recorded in status `pending`; and both routes sit behind
 * `org.manage` (a caller without it is refused 403 with no write).
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

/** A workspace_admin — does not hold `org.manage`, so the create/list authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin' };
}

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/**
 * An in-memory {@link AdminExportRequestsRepository}. `orgExists` controls the resolve-before-authorize
 * step: a cross-tenant context is modelled by constructing it `false`, exactly what the real
 * tenant-scoped resolve returns for an organization not in this tenant.
 */
class FakeAdminExportRequestsRepository {
  readonly rows: AdminExportRequestRow[] = [];
  insertCalls = 0;

  constructor(private readonly orgExists = true) {}

  resolveOrganization(): Promise<{ readonly id: string } | undefined> {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }

  listAll(): Promise<readonly AdminExportRequestRow[]> {
    return Promise.resolve(this.rows);
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: { scope: AdminExportScope; requestedBy: string; requestedAt: Date },
  ): Promise<void> {
    this.insertCalls += 1;
    this.rows.push({
      id: `req-${this.rows.length + 1}`,
      organizationId: ORG,
      scope: input.scope,
      status: 'pending',
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    });
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeAdminExportRequestsRepository): AdminExportRequestsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new AdminExportRequestsController(
    database,
    repo as unknown as AdminExportRequestsRepository,
  );
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('AdminExportRequestsController (ADM export requests, x224)', () => {
  it('records a request in pending and reads it back (the tenant-scoped round trip)', async () => {
    const repo = new FakeAdminExportRequestsRepository();
    const controller = controllerWith(repo);

    const before = await controller.list(context, owner());
    expect(before.requests).toEqual([]);

    const after = await controller.create(context, owner(), { scope: 'full' });
    expect(repo.insertCalls).toBe(1);
    expect(after.requests).toHaveLength(1);
    expect(after.requests[0]).toMatchObject({ scope: 'full', status: 'pending' });
  });

  it('400s an unknown scope, without a write (no unknown scope is stored)', async () => {
    const repo = new FakeAdminExportRequestsRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.create(context, owner(), { scope: 'everything' }), 400);
    await expectStatus(controller.create(context, owner(), { scope: 42 }), 400);
    expect(repo.insertCalls).toBe(0);
  });

  it('404s a cross-tenant organization, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeAdminExportRequestsRepository(false);
    const controller = controllerWith(repo);

    await expectStatus(controller.create(context, owner(), { scope: 'members' }), 404);
    expect(repo.insertCalls).toBe(0);
  });

  it('403s a caller without org.manage on create and on list, with the real authorize, and does not write', async () => {
    const repo = new FakeAdminExportRequestsRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.create(context, orgAdmin(), { scope: 'full' }), 403);
    await expectStatus(controller.list(context, orgAdmin()), 403);
    expect(repo.insertCalls).toBe(0);
  });

  it('guards both routes with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['list', 'create'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        AdminExportRequestsController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
