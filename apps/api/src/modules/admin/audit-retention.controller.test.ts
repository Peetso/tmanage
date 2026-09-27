import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AuditRetentionController } from './audit-retention.controller.js';
import { AuditRetentionService } from './audit-retention.service.js';
import { AuditRetentionRepository } from './audit-retention.repository.js';
import type { AuditRetentionPolicyRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Audit-log retention policy (x279) over a fake repository, with the **real** `authorize`.
 *
 * The proofs this slice must carry: an out-of-range window is a 400 with no upsert; a caller without
 * `org.manage` is refused 403 by the handler's real authorize with no upsert; a cross-tenant
 * organization is a 404 before the write; and the happy path stores the window and returns the policy
 * with the read-only purge preview — while never writing to `audit_events`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const CALLER_USER = '00000000-0000-4000-8000-0000000000c1';
const CALLER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: CALLER_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: CALLER_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** An org_admin holds every capability except `org.manage`, so the caller authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

const context = { organizationId: ORG, userId: CALLER_USER } as unknown as TenantContext;

/** A fake repository recording writes; `orgExists` models the cross-tenant organization. */
class FakeRepo extends AuditRetentionRepository {
  upserts: { retentionDays: number; updatedBy: string }[] = [];
  constructor(
    private readonly policy: AuditRetentionPolicyRow | undefined = undefined,
    private readonly orgExists = true,
    private readonly olderCount = 0,
  ) {
    super();
  }
  override resolveOrganization() {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }
  override find() {
    return Promise.resolve(this.policy);
  }
  override upsert(_r: unknown, _c: unknown, input: { retentionDays: number; updatedBy: string }) {
    this.upserts.push(input);
    return Promise.resolve();
  }
  override countEventsOlderThan() {
    return Promise.resolve(this.olderCount);
  }
}

function controllerWith(repo: FakeRepo): AuditRetentionController {
  const database = {
    read: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new AuditRetentionController(database, new AuditRetentionService(repo));
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

function policyRow(retentionDays: number): AuditRetentionPolicyRow {
  return {
    id: '00000000-0000-4000-8000-0000000000d1',
    organizationId: ORG,
    retentionDays,
    updatedBy: CALLER_USER,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

describe('AuditRetentionController (ADM audit retention, x279)', () => {
  it('400s retentionDays=0 and never upserts', async () => {
    const repo = new FakeRepo();
    await expectStatus(controllerWith(repo).set(context, owner(), { retentionDays: 0 }), 400);
    expect(repo.upserts).toEqual([]);
  });

  it('400s retentionDays over the 3650 ceiling and never upserts', async () => {
    const repo = new FakeRepo();
    await expectStatus(controllerWith(repo).set(context, owner(), { retentionDays: 3651 }), 400);
    expect(repo.upserts).toEqual([]);
  });

  it('400s a non-integer or missing window and never upserts', async () => {
    const repo = new FakeRepo();
    await expectStatus(controllerWith(repo).set(context, owner(), { retentionDays: 1.5 }), 400);
    await expectStatus(controllerWith(repo).set(context, owner(), {}), 400);
    expect(repo.upserts).toEqual([]);
  });

  it('403s a caller without org.manage, with the real authorize, and never upserts', async () => {
    const repo = new FakeRepo();
    await expectStatus(controllerWith(repo).set(context, orgAdmin(), { retentionDays: 30 }), 403);
    expect(repo.upserts).toEqual([]);
  });

  it('404s a cross-tenant organization before the write (Known trap)', async () => {
    const repo = new FakeRepo(undefined, false);
    await expectStatus(controllerWith(repo).set(context, owner(), { retentionDays: 30 }), 404);
    expect(repo.upserts).toEqual([]);
  });

  it('upserts a valid window and returns the policy with the purge preview', async () => {
    const repo = new FakeRepo(policyRow(30), true, 7);
    const view = await controllerWith(repo).set(context, owner(), { retentionDays: 30 });
    expect(repo.upserts).toEqual([{ retentionDays: 30, updatedBy: CALLER_USER }]);
    expect(view.retentionDays).toBe(30);
    expect(view.eventsOlderThanWindow).toBe(7);
  });

  it('reads the default view (no window, no preview) when none is set', async () => {
    const view = await controllerWith(new FakeRepo(undefined, true)).read(context, owner());
    expect(view.retentionDays).toBeNull();
    expect(view.eventsOlderThanWindow).toBe(0);
  });

  it('guards both routes with org.manage', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, AuditRetentionController.prototype.set)).toBe(
      'org.manage',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, AuditRetentionController.prototype.read)).toBe(
      'org.manage',
    );
  });
});
