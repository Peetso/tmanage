import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import type { RequestContext } from '../src/modules/platform-admin/platform-admin.service.js';
import { PlatformOrganizationsRepository } from '../src/modules/platform-admin/organizations/organizations.repository.js';
import { PlatformOrganizationsService } from '../src/modules/platform-admin/organizations/organizations.service.js';
import { PlatformOrganizationMembersService } from '../src/modules/platform-admin/organizations/members.service.js';
import { InvitationsRepository } from '../src/modules/tenancy/invitations.repository.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { OffboardingService } from '../src/modules/tenancy/offboarding.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-014 against a real server — Organizations A2–A6 (platform-admin v2, PA-07, 0243).
 *
 * 1. The list's statement runs through the tenant guard's bootstrap path: search narrows it, the
 *    status counts add up, and the detail reads every tenant table with its organization bound.
 * 2. A profile edit lands with its platform audit row in the same transaction; a slug another
 *    organization holds is a 409 and changes nothing.
 * 3. Limit overrides upsert `organization_limits` (INSERT/UPDATE only).
 * 4. A role change goes through the grant ceiling and writes the org audit row and the platform
 *    one; the only owner cannot be demoted.
 */

let db: TestDatabase;
let world: SeedWorld;
let service: PlatformOrganizationsService;
let members: PlatformOrganizationMembersService;

function ctx(): RequestContext {
  return {
    correlationId: uuidv7(),
    ip: '203.0.113.14',
    userAgent: 'Firefox/130',
  } as RequestContext;
}

function superAdmin(): PlatformAdminActor {
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
    source: 'env',
    preset: 'super_admin',
    permissions: [...PLATFORM_PERMISSIONS],
  } as PlatformAdminActor;
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  const orgs = new PlatformOrganizationsRepository(tenant);
  const audit = new AuditService(tenant);
  const memberships = new MembershipsRepository();
  service = new PlatformOrganizationsService(new PlatformAdminRepository(tenant), orgs);
  members = new PlatformOrganizationMembersService(
    service,
    orgs,
    memberships,
    new InvitationsRepository(),
    new OffboardingService(tenant, memberships, audit),
    audit,
  );
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe('organizations list and detail', () => {
  it('search narrows the list and the counts add up', async () => {
    const all = await service.list({}, ctx());
    expect(all.counts.all).toBe(
      all.counts.active + all.counts.suspended + all.counts.deleted + all.counts.archived,
    );
    expect(all.organizations.map((o) => o.slug)).toEqual(
      expect.arrayContaining(['northstar-studio', 'brightops-consulting']),
    );
    // The adversarial twin (`northstar-studios`) matches too; BrightOps does not.
    const found = await service.list({ q: 'northstar' }, ctx());
    const slugs = found.organizations.map((o) => o.slug);
    expect(slugs).toContain('northstar-studio');
    expect(slugs).not.toContain('brightops-consulting');
  });

  it('reads one organization with its owners and counts', async () => {
    const detail = await service.detail(world.northstar.organizationId, ctx());
    expect(detail.organization).toMatchObject({ slug: 'northstar-studio', status: 'active' });
    expect(detail.admins.map((a) => a.email)).toContain(world.northstar.owner.email);
  });
});

describe('profile', () => {
  it('a rename lands with its platform audit row', async () => {
    const context = ctx();
    const written = await service.updateProfile(
      superAdmin(),
      world.northstar.organizationId,
      { name: 'Northstar Studio Ltd' },
      context,
    );
    expect(written.organization.name).toBe('Northstar Studio Ltd');
    const rows = await observe(
      'select action, target_id from platform_admin_audit_events where correlation_id = ?',
      [context.correlationId],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'platform.organization_updated',
        target_id: world.northstar.organizationId,
      }),
    ]);
  });

  it("BrightOps' slug is a 409 and nothing changes", async () => {
    await expect(
      service.updateProfile(
        superAdmin(),
        world.northstar.organizationId,
        { slug: 'brightops-consulting' },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const [row] = await observe('select slug from organizations where id = ?', [
      world.northstar.organizationId,
    ]);
    expect(row?.['slug']).toBe('northstar-studio');
  });
});

describe('limits', () => {
  it('an override upserts organization_limits and reads back merged', async () => {
    const view = await service.setLimits(
      superAdmin(),
      world.northstar.organizationId,
      { people: 25, activeProjects: null, storageBytes: null },
      ctx(),
    );
    expect(view.limits.people.override).toBe(25);
    const again = await service.setLimits(
      superAdmin(),
      world.northstar.organizationId,
      { people: 30, activeProjects: null, storageBytes: null },
      ctx(),
    );
    expect(again.limits.people.override).toBe(30);
    const rows = await observe(
      'select people_limit from organization_limits where organization_id = ?',
      [world.northstar.organizationId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.['people_limit'])).toBe(30);
  });
});

describe('members', () => {
  it('changes a role with the org and platform audit rows', async () => {
    const context = ctx();
    const written = await members.changeRole(
      superAdmin(),
      world.northstar.organizationId,
      world.northstar.designer.membershipId,
      { role: 'manager' },
      context,
    );
    expect(written.member.role).toBe('manager');
    const platform = await observe(
      'select action from platform_admin_audit_events where correlation_id = ?',
      [context.correlationId],
    );
    expect(platform.map((r) => r['action'])).toContain('platform.member_role_changed');
    const org = await observe(
      'select action from audit_events where organization_id = ? and correlation_id = ?',
      [world.northstar.organizationId, context.correlationId],
    );
    expect(org.map((r) => r['action'])).toContain('membership.role_changed');
  });

  it('refuses to demote the only owner', async () => {
    await expect(
      members.changeRole(
        superAdmin(),
        world.northstar.organizationId,
        world.northstar.owner.membershipId,
        { role: 'member' },
        ctx(),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
