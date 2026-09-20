import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2/promise';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { capabilitiesFor } from '@tmanage/domain';
import { ImportService } from '../src/modules/import/import.service.js';
import type { SourceMapping, SourceRow } from '../src/modules/import/import-validation.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ON-09 commit half (x100) — the tenant-scoped validate -> commit round-trip against a real
 * server. The migration (`0032_import_rows`) is proven applied by `migrator.db.test.ts`; this
 * suite proves the behaviour on top of it: a validated job's rows become real projects, each
 * with a per-row receipt, the job transitions to its terminal status, and none of it crosses a
 * tenant boundary.
 *
 * It drives `ImportService` directly (real repositories, real `TenantDatabase`) rather than over
 * HTTP: the object-layer `project.create` authorize lives in the service, so a service-level
 * round-trip exercises exactly the path the slice adds, in a fraction of the wall-clock a full
 * Nest bootstrap costs.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;
let service: ImportService;

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });

const ownerPrincipal = (tenantCtx: TenantContext): Principal => ({
  userId: tenantCtx.userId,
  organizationId: tenantCtx.organizationId,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-owner',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
});

const mapping = (): SourceMapping => ({
  name: 'Project Name',
  workspaceId: 'Workspace',
  targetDate: 'Due',
});

const row = (workspaceId: string, over: Record<string, unknown> = {}): SourceRow => ({
  'Project Name': 'Imported project',
  Workspace: workspaceId,
  Due: '2026-11-30',
  ...over,
});

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
  service = new ImportService(tenant);
});

afterAll(async () => {
  await db?.stop();
});

describe('0032 import commit: validate -> commit round-trip', () => {
  it('commits an all-valid job: every row becomes a project with a created receipt', async () => {
    const ws = world.northstar.workspaceId;
    const batch = { sourceKind: 'project' as const, mapping: mapping(), rows: [row(ws), row(ws)] };

    const validated = await service.validate(northstar, batch);
    expect(validated.status).toBe('validated');

    const committed = await service.commit(northstar, ownerPrincipal(northstar), {
      jobId: validated.jobId,
      ...batch,
    });

    expect(committed.status).toBe('committed');
    expect(committed.committedCount).toBe(2);
    expect(committed.failedCount).toBe(0);

    // Both projects exist, in the acting tenant and workspace, with the mapped forecast date.
    const createdIds = committed.rows.map((r) => r.createdEntityId);
    for (const id of createdIds) {
      const rows = await observe(
        `SELECT organization_id AS o, workspace_id AS w, name AS n, forecast_at AS f
           FROM projects WHERE id = ?`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.['o'])).toBe(world.northstar.organizationId);
      expect(String(rows[0]?.['w'])).toBe(ws);
      expect(String(rows[0]?.['n'])).toBe('Imported project');
      // `forecast_at` is a DATE column (0012); the raw admin driver hands it back as a Date at
      // midnight UTC, so compare the calendar date rather than its locale string form.
      expect(new Date(rows[0]?.['f'] as string | Date).toISOString().slice(0, 10)).toBe(
        '2026-11-30',
      );
    }

    // Two `created` receipts for the job, and the job reached its terminal committed state.
    const receipts = await observe(
      `SELECT outcome AS o, created_entity_id AS e FROM import_rows
         WHERE organization_id = ? AND job_id = ? ORDER BY source_index`,
      [world.northstar.organizationId, validated.jobId],
    );
    expect(receipts.map((r) => String(r['o']))).toEqual(['created', 'created']);
    expect(receipts.every((r) => r['e'] !== null)).toBe(true);

    const job = await observe(
      `SELECT status AS s, committed_count AS c, failed_count AS f, committed_at AS a
         FROM import_jobs WHERE organization_id = ? AND id = ?`,
      [world.northstar.organizationId, validated.jobId],
    );
    expect(String(job[0]?.['s'])).toBe('committed');
    expect(Number(job[0]?.['c'])).toBe(2);
    expect(Number(job[0]?.['f'])).toBe(0);
    expect(job[0]?.['a']).not.toBeNull();
  });

  it('commits the valid rows of a mixed job and records the invalid one (partial commit)', async () => {
    const ws = world.northstar.workspaceId;
    const batch = {
      sourceKind: 'project' as const,
      mapping: mapping(),
      rows: [row(ws), row(ws, { 'Project Name': '   ' }), row(ws)],
    };

    const validated = await service.validate(northstar, batch);
    expect(validated.status).toBe('validated_with_errors');

    const committed = await service.commit(northstar, ownerPrincipal(northstar), {
      jobId: validated.jobId,
      ...batch,
    });

    expect(committed.status).toBe('committed_with_errors');
    expect(committed.committedCount).toBe(2);
    expect(committed.failedCount).toBe(1);

    const receipts = await observe(
      `SELECT source_index AS i, outcome AS o, created_entity_id AS e, error_detail AS d
         FROM import_rows WHERE organization_id = ? AND job_id = ? ORDER BY source_index`,
      [world.northstar.organizationId, validated.jobId],
    );
    expect(receipts.map((r) => String(r['o']))).toEqual(['created', 'failed', 'created']);
    // The failed row carries no entity id and a non-empty error; the valid ones carry an id.
    expect(receipts[1]?.['e']).toBeNull();
    expect(String(receipts[1]?.['d']).length).toBeGreaterThan(0);
    expect(receipts[0]?.['e']).not.toBeNull();
  });

  it('never resolves a cross-tenant job and refuses a second commit', async () => {
    const ws = world.northstar.workspaceId;
    const batch = { sourceKind: 'project' as const, mapping: mapping(), rows: [row(ws)] };
    const validated = await service.validate(northstar, batch);

    // The twin cannot see Northstar's job: 404, never a 500 and never a leak.
    await expect(
      service.commit(twin, ownerPrincipal(twin), { jobId: validated.jobId, ...batch }),
    ).rejects.toMatchObject({ status: 404 });

    // First commit in the owning tenant succeeds; a second is refused (already committed).
    await service.commit(northstar, ownerPrincipal(northstar), {
      jobId: validated.jobId,
      ...batch,
    });
    await expect(
      service.commit(northstar, ownerPrincipal(northstar), { jobId: validated.jobId, ...batch }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
