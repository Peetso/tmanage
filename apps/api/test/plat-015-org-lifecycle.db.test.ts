import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import type { RequestContext } from '../src/modules/platform-admin/platform-admin.service.js';
import { PlatformOrganizationLifecycleService } from '../src/modules/platform-admin/organizations/lifecycle.service.js';
import { PlatformOrganizationsRepository } from '../src/modules/platform-admin/organizations/organizations.repository.js';
import { PlatformOrganizationsService } from '../src/modules/platform-admin/organizations/organizations.service.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../src/modules/tenancy/membership-resolver.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-015 against a real server — the organization lifecycle (platform-admin v2, PA-07, 0243).
 *
 * 1. Removal needs the typed slug; it stamps `deleted_at`, `purge_after` from the retention
 *    setting and the deleter, and from then on the membership resolver refuses every member.
 * 2. The deleted list shows it inside the restore window; restore clears the stamps and the owner
 *    resolves again.
 * 3. Purge is a super admin's, on a deleted organization only: it brings `purge_after` to now so
 *    the worker's sweep hands it to erasure on its next pass.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = 'Customer asked to close the account';

let db: TestDatabase;
let world: SeedWorld;
let service: PlatformOrganizationsService;
let lifecycle: PlatformOrganizationLifecycleService;
let resolver: MembershipResolver;

function ctx(): RequestContext {
  return {
    correlationId: uuidv7(),
    ip: '203.0.113.15',
    userAgent: 'Firefox/130',
  } as RequestContext;
}

function admin(preset: 'super_admin' | 'support' = 'super_admin'): PlatformAdminActor {
  return {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: world.platformAdmin.displayName,
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: uuidv7(),
    stepUp: null,
    source: 'db',
    preset,
    permissions: [...PLATFORM_PERMISSIONS],
  } as PlatformAdminActor;
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

const resolveOwner = () =>
  resolver.resolve({
    userId: world.brightops.owner.id,
    organization: { slug: 'brightops-consulting' },
    correlationId: uuidv7(),
  });

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  const tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: () => undefined,
  });
  const orgs = new PlatformOrganizationsRepository(tenant);
  service = new PlatformOrganizationsService(new PlatformAdminRepository(tenant), orgs);
  lifecycle = new PlatformOrganizationLifecycleService(
    service,
    orgs,
    new MembershipsRepository(),
    new AuditService(tenant),
  );
  resolver = new MembershipResolver(tenant);
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe('delete, restore, purge', () => {
  const id = () => world.brightops.organizationId;

  it('the owner resolves before anything happens', async () => {
    const resolved = await resolveOwner();
    expect(resolved.context.organizationId).toBe(id());
  });

  it('a wrong typed slug is a 400 and nothing changes', async () => {
    await expect(
      lifecycle.remove(admin(), id(), { confirmSlug: 'BrightOps', reason: REASON }, ctx()),
    ).rejects.toMatchObject({ status: 400 });
    const [row] = await observe('select deleted_at from organizations where id = ?', [id()]);
    expect(row?.['deleted_at']).toBeNull();
  });

  it('removal stamps the row from the retention setting and the resolver refuses', async () => {
    const before = Date.now();
    const written = await lifecycle.remove(
      admin(),
      id(),
      { confirmSlug: 'brightops-consulting', reason: REASON },
      ctx(),
    );
    expect(written.organization.status).toBe('deleted');
    const [row] = await observe(
      'select deleted_at, purge_after, deleted_by_user_id from organizations where id = ?',
      [id()],
    );
    expect(row?.['deleted_by_user_id']).toBe(world.platformAdmin.id);
    const purgeAfter = new Date(row?.['purge_after'] as Date).getTime();
    // 30 days by default; a day either side absorbs the server's clock and time zone.
    expect(purgeAfter).toBeGreaterThan(before + 29 * DAY_MS);
    expect(purgeAfter).toBeLessThan(before + 31 * DAY_MS);
    await expect(resolveOwner()).rejects.toBeInstanceOf(MembershipNotResolvedError);
  });

  it('the deleted list shows it inside the restore window', async () => {
    const deleted = await service.deleted(ctx());
    const entry = deleted.organizations.find((o) => o.id === id());
    expect(entry).toMatchObject({
      slug: 'brightops-consulting',
      deletedByEmail: world.platformAdmin.email,
    });
    expect(entry?.daysLeft).toBeGreaterThanOrEqual(29);
  });

  it('restore clears the stamps and the owner resolves again', async () => {
    const written = await lifecycle.restore(admin(), id(), { reason: REASON }, ctx());
    expect(written.organization.status).toBe('active');
    const [row] = await observe('select deleted_at, purge_after from organizations where id = ?', [
      id(),
    ]);
    expect(row).toMatchObject({ deleted_at: null, purge_after: null });
    const resolved = await resolveOwner();
    expect(resolved.context.organizationId).toBe(id());
  });

  it('purge is refused on a live organization and for a support admin', async () => {
    await expect(
      lifecycle.purge(
        admin(),
        id(),
        { confirmSlug: 'brightops-consulting', reason: REASON },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      lifecycle.purge(
        admin('support'),
        id(),
        { confirmSlug: 'brightops-consulting', reason: REASON },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('purge on a deleted organization brings purge_after to now, with its audit row', async () => {
    await lifecycle.remove(
      admin(),
      id(),
      { confirmSlug: 'brightops-consulting', reason: REASON },
      ctx(),
    );
    const context = ctx();
    await lifecycle.purge(
      admin(),
      id(),
      { confirmSlug: 'brightops-consulting', reason: REASON },
      context,
    );
    const [row] = await observe('select purge_after from organizations where id = ?', [id()]);
    expect(new Date(row?.['purge_after'] as Date).getTime()).toBeLessThanOrEqual(
      Date.now() + DAY_MS,
    );
    const audit = await observe(
      'select action, reason from platform_admin_audit_events where correlation_id = ?',
      [context.correlationId],
    );
    expect(audit).toEqual([
      expect.objectContaining({ action: 'platform.organization_purge_requested', reason: REASON }),
    ]);
  });
});
