import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { InsightAnnotationsController } from './insight-annotations.controller.js';
import { InsightAnnotationsService } from './insight-annotations.service.js';
import type { InsightAnnotationsRepository } from './insight-annotations.repository.js';
import type { InsightSnapshotsRepository } from './snapshots.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightAnnotationRow, InsightSnapshotRow } from '../../common/database/schema.js';

/**
 * x271 — insight annotations. Database-free proofs over the module with the **real** `authorize`. The
 * insert/list/delete data paths are ordinary tenant-scoped SQL, so the properties proven are the ones
 * the HTTP surface owns:
 *   - a client (a principal `work.read` refuses — the capability is internal-only) is a 403, the
 *     org-level relation half of the route's ceiling, checked before any write;
 *   - an unknown snapshot is a 404 (the soft read of x211), never a stored row;
 *   - an empty note is a 400 and nothing is written;
 *   - a well-formed note persists as the caller's own membership;
 *   - **the mandated refusal:** deleting another author's annotation is a 403 with no delete;
 *   - every route sits behind `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const SNAPSHOT = 'snapshot-0000-0000-0000-000000000001';
const MY_MEMBERSHIP = 'membership-0000-0000-000000000001';
const OTHER_MEMBERSHIP = 'membership-0000-0000-000000000002';

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

function orgWide(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'org_admin',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [],
    hasOrgWideScope: false,
  };
}

interface Stored {
  id: string;
  snapshotId: string;
  authorMembershipId: string;
  note: string;
  createdAt: Date;
}

class FakeAnnotationsRepository {
  readonly rows: Stored[] = [];
  private seq = 0;

  insert(_r: unknown, _c: unknown, input: Omit<Stored, 'id'>): Promise<InsightAnnotationRow> {
    const row: Stored = { id: `an-${++this.seq}`, ...input };
    this.rows.push(row);
    return Promise.resolve(row as unknown as InsightAnnotationRow);
  }

  findById(
    _r: unknown,
    _c: unknown,
    snapshotId: string,
    id: string,
  ): Promise<InsightAnnotationRow | null> {
    const found = this.rows.find((row) => row.snapshotId === snapshotId && row.id === id) ?? null;
    return Promise.resolve(found as unknown as InsightAnnotationRow | null);
  }

  deleteOwn(
    _r: unknown,
    _c: unknown,
    snapshotId: string,
    id: string,
    authorMembershipId: string,
  ): Promise<void> {
    const kept = this.rows.filter(
      (row) =>
        !(
          row.snapshotId === snapshotId &&
          row.id === id &&
          row.authorMembershipId === authorMembershipId
        ),
    );
    this.rows.length = 0;
    this.rows.push(...kept);
    return Promise.resolve();
  }

  listForSnapshot(
    _r: unknown,
    _c: unknown,
    snapshotId: string,
  ): Promise<readonly InsightAnnotationRow[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.snapshotId === snapshotId) as unknown as InsightAnnotationRow[],
    );
  }
}

/** A snapshots repo that resolves only the one known snapshot id (else null → the service 404s). */
class FakeSnapshotsRepository {
  findById(_r: unknown, _c: unknown, id: string): Promise<InsightSnapshotRow | null> {
    return Promise.resolve(
      id === SNAPSHOT ? ({ id, organizationId: ORG } as unknown as InsightSnapshotRow) : null,
    );
  }
}

function controllerWith(repo: FakeAnnotationsRepository): InsightAnnotationsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InsightAnnotationsService(
    database,
    repo as unknown as InsightAnnotationsRepository,
    new FakeSnapshotsRepository() as unknown as InsightSnapshotsRepository,
  );
  return new InsightAnnotationsController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InsightAnnotationsController (x271)', () => {
  it('creates a well-formed note as the caller’s own membership', async () => {
    const repo = new FakeAnnotationsRepository();
    const view = await controllerWith(repo).add(context, orgWide(), SNAPSHOT, { note: 'context' });
    expect(view.note).toBe('context');
    expect(view.authorMembershipId).toBe(MY_MEMBERSHIP);
    expect(repo.rows).toHaveLength(1);
  });

  it('refuses a caller without work.read with a 403 before any write', async () => {
    const repo = new FakeAnnotationsRepository();
    await expectStatus(controllerWith(repo).add(context, client(), SNAPSHOT, { note: 'x' }), 403);
    expect(repo.rows).toHaveLength(0);
  });

  it('404s an annotation on an unknown snapshot and writes nothing', async () => {
    const repo = new FakeAnnotationsRepository();
    await expectStatus(controllerWith(repo).add(context, orgWide(), 'no-such', { note: 'x' }), 404);
    expect(repo.rows).toHaveLength(0);
  });

  it('400s an empty note and writes nothing (the validation refusal)', async () => {
    const repo = new FakeAnnotationsRepository();
    await expectStatus(
      controllerWith(repo).add(context, orgWide(), SNAPSHOT, { note: '   ' }),
      400,
    );
    expect(repo.rows).toHaveLength(0);
  });

  it('lists a snapshot’s annotations for a permitted principal', async () => {
    const repo = new FakeAnnotationsRepository();
    await controllerWith(repo).add(context, orgWide(), SNAPSHOT, { note: 'one' });
    const { annotations } = await controllerWith(repo).list(context, orgWide(), SNAPSHOT);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.note).toBe('one');
  });

  it('403s deleting another author’s annotation and does not delete (the mandated refusal)', async () => {
    const repo = new FakeAnnotationsRepository();
    repo.rows.push({
      id: 'an-foreign',
      snapshotId: SNAPSHOT,
      authorMembershipId: OTHER_MEMBERSHIP,
      note: 'not mine',
      createdAt: new Date('2026-09-27T00:00:00Z'),
    });
    await expectStatus(
      controllerWith(repo).remove(context, orgWide(), SNAPSHOT, 'an-foreign'),
      403,
    );
    expect(repo.rows).toHaveLength(1);
  });

  it('204s deleting the caller’s own annotation', async () => {
    const repo = new FakeAnnotationsRepository();
    const view = await controllerWith(repo).add(context, orgWide(), SNAPSHOT, { note: 'mine' });
    await controllerWith(repo).remove(context, orgWide(), SNAPSHOT, view.id);
    expect(repo.rows).toHaveLength(0);
  });

  it('guards every route with report.view', () => {
    for (const method of ['list', 'add', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        InsightAnnotationsController.prototype[method],
      );
      expect(capability).toBe('report.view');
    }
  });
});
