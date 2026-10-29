import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { bindAuditOrigin } from '../src/common/http/request-origin.js';
import { AuditEventChangesRepository } from '../src/modules/audit/audit-event-changes.repository.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { MAX_CHANGE_VALUE_LENGTH } from '../src/modules/audit/audit-redaction.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PLAT-011 against a real server — the org audit detail (platform-admin v2, PA-02, 0240 + 0241).
 *
 * 1. `AuditService.record` with `changes[]` writes one `audit_event_changes` row per field in the
 *    caller's transaction: secret-looking fields keep their name and lose their values, every
 *    value is capped at 2000 characters, and a rollback leaves neither the event nor its changes.
 * 2. A request inside Support mode stamps IP, device, the support session and the admin as the
 *    effective actor on `audit_events`, and bumps `platform_support_sessions.actions_count`.
 * 3. A change row can never point at another organization's event: the composite foreign key
 *    refuses it on the server.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let audit: AuditService;
const changes = new AuditEventChangesRepository();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function contextFor(organizationId: string, userId: string, membershipId: string): TenantContext {
  return createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-10-28',
    correlationId: uuidv7(),
  });
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
  audit = new AuditService(tenant, new AuditEventsRepository());
});

afterAll(async () => {
  await db?.stop();
});

describe('audit_event_changes', () => {
  it('writes the redacted, capped changes with the event, in the same transaction', async () => {
    const long = 'x'.repeat(MAX_CHANGE_VALUE_LENGTH + 500);
    const event = await tenant.transaction(northstar, (tx) =>
      audit.record(tx, northstar, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: world.northstar.projectId,
        metadata: { project_id: world.northstar.projectId },
        changes: [
          { field: 'name', before: 'Website redesign', after: 'Website relaunch' },
          { field: 'description', before: null, after: long },
          { field: 'refresh_token', before: 'r-old', after: 'r-new' },
        ],
      }),
    );
    const rows = await observe(
      `select organization_id, field, before_value, after_value, redacted
         from audit_event_changes where audit_event_id = ? order by field`,
      [event.id],
    );
    expect(rows.map((r) => [r['field'], r['before_value'], Number(r['redacted'])])).toEqual([
      ['description', null, 0],
      ['name', 'Website redesign', 0],
      ['refresh_token', null, 1],
    ]);
    expect(String(rows[0]?.['after_value'])).toHaveLength(MAX_CHANGE_VALUE_LENGTH);
    expect(rows[2]?.['after_value']).toBeNull();
    expect(new Set(rows.map((r) => r['organization_id']))).toEqual(
      new Set([world.northstar.organizationId]),
    );
    // Read back through the tenant path, for this organization only.
    const listed = await tenant.read(northstar, (runner) =>
      changes.listFor(runner, northstar, event.id),
    );
    expect(listed.map((row) => row.field).sort()).toEqual(['description', 'name', 'refresh_token']);
  });

  it('leaves neither the event nor its changes when the command rolls back', async () => {
    const correlated = { ...northstar, correlationId: uuidv7() } as TenantContext;
    await expect(
      tenant.transaction(correlated, async (tx) => {
        await audit.record(tx, correlated, {
          action: 'project_membership.granted',
          result: 'allowed',
          objectId: world.northstar.projectId,
          metadata: { project_id: world.northstar.projectId },
          changes: [{ field: 'name', before: 'A', after: 'B' }],
        });
        throw new Error('the command failed after its audit append');
      }),
    ).rejects.toThrow('the command failed');
    const left = await observe(
      `select count(*) as n from audit_events e join audit_event_changes c
          on c.organization_id = e.organization_id and c.audit_event_id = e.id
        where e.correlation_id = ?`,
      [correlated.correlationId],
    );
    expect(Number(left[0]?.['n'])).toBe(0);
  });

  it('stamps the support origin and counts the action against the support session', async () => {
    const sessionId = uuidv7();
    await db.admin.execute(
      `insert into platform_support_sessions
         (id, admin_user_id, browser_session_id, organization_id, membership_id, reason,
          started_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        world.platformAdmin.id,
        uuidv7(),
        world.northstar.organizationId,
        world.northstar.owner.membershipId,
        'Customer asked for help',
        new Date('2026-10-28T09:00:00Z'),
        new Date('2099-01-01T00:00:00Z'),
      ],
    );
    const bound = bindAuditOrigin(northstar, {
      ip: '198.51.100.20',
      userAgent: 'Chrome/130',
      supportSession: { id: sessionId, adminUserId: world.platformAdmin.id },
    });
    const event = await tenant.transaction(bound, (tx) =>
      audit.record(tx, bound, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: world.northstar.projectId,
        metadata: { project_id: world.northstar.projectId },
      }),
    );
    const [row] = await observe(
      `select ip, user_agent, platform_support_session_id, effective_actor_id, actor_user_id
         from audit_events where id = ?`,
      [event.id],
    );
    expect(row).toMatchObject({
      ip: '198.51.100.20',
      user_agent: 'Chrome/130',
      platform_support_session_id: sessionId,
      effective_actor_id: world.platformAdmin.id,
      actor_user_id: world.northstar.owner.id,
    });
    const [session] = await observe(
      'select actions_count from platform_support_sessions where id = ?',
      [sessionId],
    );
    expect(Number(session?.['actions_count'])).toBe(1);
  });

  it("refuses a change row that points at another organization's event", async () => {
    const [theirs] = await observe(
      'select id from audit_events where organization_id <> ? limit 1',
      [world.northstar.organizationId],
    );
    const twinContext = contextFor(
      world.twin.organizationId,
      world.twin.owner.id,
      world.twin.owner.membershipId,
    );
    const twinEvent =
      theirs?.['id'] !== undefined
        ? String(theirs['id'])
        : (
            await tenant.transaction(twinContext, (tx) =>
              audit.record(tx, twinContext, {
                action: 'project_membership.granted',
                result: 'allowed',
                objectId: world.twin.projectId,
                metadata: { project_id: world.twin.projectId },
              }),
            )
          ).id;
    await expect(
      db.admin.execute(
        `insert into audit_event_changes
           (id, organization_id, audit_event_id, field, before_value, after_value, redacted, created_at)
         values (?, ?, ?, 'name', 'a', 'b', 0, current_timestamp(3))`,
        [uuidv7(), world.northstar.organizationId, twinEvent],
      ),
    ).rejects.toThrow(/foreign key/iu);
  });
});
