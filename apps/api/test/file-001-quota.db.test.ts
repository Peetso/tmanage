import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2/promise';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import {
  STORAGE_BYTES_METRIC,
  UsageCountersRepository,
} from '../src/modules/files/usage-counters.repository.js';
import { FileAssetsRepository } from '../src/modules/files/file-assets.repository.js';
import { UploadSessionsRepository } from '../src/modules/files/upload-sessions.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FILE-001's data layer — `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §6 at the row.
 *
 * The HTTP suite proves what a caller sees. This suite proves the four statements the
 * counter is made of, against the engine, with concurrent callers — because the claim
 * "concurrent upload reservations cannot oversubscribe the organization quota" (§8,
 * 27-TEST-CATALOG QUOTA-01) is a claim about InnoDB row locking and a predicate, and only
 * running the race demonstrates it. Every case here has a named reversal: the rule it pins,
 * and what the assertion reads when that rule is taken out.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

const counters = new UsageCountersRepository();
const assets = new FileAssetsRepository();
const sessions = new UploadSessionsRepository();

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-09-03',
    correlationId: uuidv7(),
  });

const northstar = (): TenantContext =>
  contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
const brightops = (): TenantContext =>
  contextFor(
    world.brightops.organizationId,
    world.brightops.owner.id,
    world.brightops.owner.membershipId,
  );

async function counterOf(organizationId: string): Promise<{ used: number; reserved: number }> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ? and metric_key = ?',
    [organizationId, STORAGE_BYTES_METRIC],
  );
  return { used: Number(rows[0]?.['used'] ?? 0), reserved: Number(rows[0]?.['reserved'] ?? 0) };
}

/** One reservation, the way the service does it: seed, then the conditional update. */
async function reserve(context: TenantContext, bytes: number, limit: number): Promise<boolean> {
  return tenant.transaction(context, async (tx) => {
    await counters.ensure(tx, context, STORAGE_BYTES_METRIC);
    return counters.reserve(tx, context, STORAGE_BYTES_METRIC, bytes, limit);
  });
}

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

describe('QUOTA-01: the reservation is one conditional statement', () => {
  it('admits exactly as many concurrent reservations as the limit holds, never one more', async () => {
    // Twelve callers, 100 bytes each, a limit that holds ten. Fired together on the pool, so
    // they contend for the one row. Reversal: replace the predicate with a read-then-write
    // and this admits twelve.
    const context = northstar();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => reserve(context, 100, 1_000)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(10);
    const counter = await counterOf(world.northstar.organizationId);
    expect(counter.reserved).toBe(1_000);
    expect(counter.used + counter.reserved).toBeLessThanOrEqual(1_000);
  });

  it('refuses a reservation that would exceed the limit even when the counter is fresh', async () => {
    expect(await reserve(northstar(), 1_001, 1_000)).toBe(false);
    expect(await counterOf(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
  });

  it('counts used and reserved bytes together', async () => {
    const context = northstar();
    expect(await reserve(context, 600, 1_000)).toBe(true);
    await tenant.transaction(context, (tx) =>
      counters.commit(tx, context, STORAGE_BYTES_METRIC, 600, 600),
    );
    expect(await counterOf(world.northstar.organizationId)).toEqual({ used: 600, reserved: 0 });
    expect(await reserve(context, 401, 1_000)).toBe(false);
    expect(await reserve(context, 400, 1_000)).toBe(true);
  });
});

describe('QUOTA-02: duplicate completion and release do not double-count', () => {
  it('commits once: a second commit for the same reservation changes nothing', async () => {
    const context = northstar();
    await reserve(context, 500, 10_000);
    const first = await tenant.transaction(context, (tx) =>
      counters.commit(tx, context, STORAGE_BYTES_METRIC, 500, 480),
    );
    const second = await tenant.transaction(context, (tx) =>
      counters.commit(tx, context, STORAGE_BYTES_METRIC, 500, 480),
    );
    expect(first).toBe(true);
    // Reversal: drop the `reserved_value >= ?` guard and the UNSIGNED column raises on the
    // underflow instead — either way this is not `true`, but the guard is what makes the
    // outcome a value the service can answer from rather than a driver error.
    expect(second).toBe(false);
    expect(await counterOf(world.northstar.organizationId)).toEqual({ used: 480, reserved: 0 });
  });

  it('releases once: cancel then expiry gives the bytes back exactly once', async () => {
    const context = northstar();
    await reserve(context, 300, 10_000);
    const cancel = await tenant.transaction(context, (tx) =>
      counters.release(tx, context, STORAGE_BYTES_METRIC, 300),
    );
    const sweep = await tenant.transaction(context, (tx) =>
      counters.release(tx, context, STORAGE_BYTES_METRIC, 300),
    );
    expect(cancel).toBe(true);
    expect(sweep).toBe(false);
    expect(await counterOf(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
  });

  it('cannot be driven negative even by a statement that skips the guard', async () => {
    // CONC-06's "counters never go negative", proved at the column: the admin credential,
    // no guard, an over-release. Reversal: make the columns signed and this writes -1.
    await reserve(northstar(), 1, 10_000);
    await expect(
      db.admin.query(
        'update usage_counters set reserved_value = reserved_value - 2 where organization_id = ?',
        [world.northstar.organizationId],
      ),
    ).rejects.toThrow();
  });
});

describe('QUOTA-03: the counter is the organization’s, and only theirs', () => {
  it('keeps two tenants’ counters apart under the same metric key', async () => {
    expect(await reserve(northstar(), 900, 1_000)).toBe(true);
    // Brightops has the same limit and nothing reserved: Northstar's bytes are not theirs.
    expect(await reserve(brightops(), 900, 1_000)).toBe(true);
    expect(await counterOf(world.northstar.organizationId)).toEqual({ used: 0, reserved: 900 });
    expect(await counterOf(world.brightops.organizationId)).toEqual({ used: 0, reserved: 900 });
  });

  it('refuses to move a counter, a session or a version between tenants at the engine', async () => {
    const context = northstar();
    await reserve(context, 10, 1_000);
    await expect(
      db.admin.query('update usage_counters set organization_id = ? where organization_id = ?', [
        world.brightops.organizationId,
        world.northstar.organizationId,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('the session and the asset', () => {
  it('creates an asset at the machine’s initial state and refuses a move it has no facts for', async () => {
    const context = northstar();
    const asset = await tenant.transaction(context, (tx) =>
      assets.create(tx, context, {
        projectId: world.northstar.projectId,
        clientOrganizationId: null,
        ownerUserId: world.northstar.owner.id,
        name: 'brief.pdf',
        purpose: 'document',
        audience: 'internal',
      }),
    );
    expect(asset.status).toBe('created');
    await tenant.transaction(context, (tx) =>
      assets.transition(tx, context, asset.id, 'uploading'),
    );
    // `uploading -> uploaded` requires `byteSize` (packages/domain). Reversal: drop the
    // machine from `transition` and this writes `uploaded` with no size.
    await expect(
      tenant.transaction(context, (tx) => assets.transition(tx, context, asset.id, 'uploaded')),
    ).rejects.toThrow(/byteSize/);
    const uploaded = await tenant.transaction(context, (tx) =>
      assets.transition(tx, context, asset.id, 'uploaded', { byteSize: 12 }),
    );
    expect(uploaded.status).toBe('uploaded');
  });

  it('refuses a second session under the same idempotency key, in the same transaction as its reservation', async () => {
    const context = northstar();
    const asset = await tenant.transaction(context, (tx) =>
      assets.create(tx, context, {
        projectId: world.northstar.projectId,
        clientOrganizationId: null,
        ownerUserId: world.northstar.owner.id,
        name: 'brief.pdf',
        purpose: 'document',
        audience: 'internal',
      }),
    );
    const input = (id: string) => ({
      id,
      projectId: world.northstar.projectId,
      clientOrganizationId: null,
      actorUserId: world.northstar.owner.id,
      fileAssetId: asset.id,
      idempotencyKey: 'brief-upload-0001',
      purpose: 'document' as const,
      declaredName: 'brief.pdf',
      declaredMimeType: 'application/pdf',
      declaredBytes: 100,
      declaredContentHash: null,
      partSizeBytes: 100,
      partCount: 1,
      objectKey: `tenant/${world.northstar.organizationId}/project/${world.northstar.projectId}/upload/${id}/object`,
      providerUploadId: `fake-${id}`,
      uploadTargets: [{ partNumber: 1, url: `memory://${id}/part/1` }],
      expiresAt: new Date(Date.now() + 60_000),
    });

    const created = await tenant.transaction(context, async (tx) => {
      await counters.ensure(tx, context, STORAGE_BYTES_METRIC);
      await counters.reserve(tx, context, STORAGE_BYTES_METRIC, 100, 10_000);
      return sessions.create(tx, context, input(sessions.nextId()));
    });
    expect(created.status).toBe('reserved');

    // The replay: reserve, then insert, in one transaction. The insert is refused and the
    // rollback takes the reservation with it. Reversal: drop
    // `uq_upload_sessions_org_idempotency` and this reserves 200.
    await expect(
      tenant.transaction(context, async (tx) => {
        await counters.reserve(tx, context, STORAGE_BYTES_METRIC, 100, 10_000);
        return sessions.create(tx, context, input(sessions.nextId()));
      }),
    ).rejects.toThrow(/idempotency key/);
    expect(await counterOf(world.northstar.organizationId)).toEqual({ used: 0, reserved: 100 });

    // A session leaves `reserved` once. The second caller reads `false` and repeats nothing.
    const first = await tenant.transaction(context, (tx) =>
      sessions.transition(tx, context, created.id, ['reserved'], 'completed', {
        committedBytes: 100,
      }),
    );
    const again = await tenant.transaction(context, (tx) =>
      sessions.transition(tx, context, created.id, ['reserved'], 'completed', {
        committedBytes: 100,
      }),
    );
    expect(first).toBe(true);
    expect(again).toBe(false);
    const cancelAfter = await tenant.transaction(context, (tx) =>
      sessions.transition(tx, context, created.id, ['reserved'], 'cancelled'),
    );
    expect(cancelAfter).toBe(false);
  });

  it('numbers versions from one and refuses to rewrite a version’s bytes', async () => {
    const context = northstar();
    const asset = await tenant.transaction(context, (tx) =>
      assets.create(tx, context, {
        projectId: world.northstar.projectId,
        clientOrganizationId: null,
        ownerUserId: world.northstar.owner.id,
        name: 'brief.pdf',
        purpose: 'document',
        audience: 'internal',
      }),
    );
    const key = `tenant/${world.northstar.organizationId}/project/${world.northstar.projectId}/upload/${uuidv7()}/object`;
    const v1 = await tenant.transaction(context, (tx) =>
      assets.createVersion(tx, context, {
        fileAssetId: asset.id,
        objectKey: key,
        sizeBytes: 10,
        declaredMimeType: 'application/pdf',
        etag: 'e1',
      }),
    );
    const v2 = await tenant.transaction(context, (tx) =>
      assets.createVersion(tx, context, {
        fileAssetId: asset.id,
        objectKey: key,
        sizeBytes: 11,
        declaredMimeType: 'application/pdf',
        etag: 'e2',
      }),
    );
    expect([v1.versionNo, v2.versionNo]).toEqual([1, 2]);
    await expect(
      db.admin.query('update file_versions set size_bytes = 99 where id = ?', [v1.id]),
    ).rejects.toThrow(/immutable/);
  });
});
