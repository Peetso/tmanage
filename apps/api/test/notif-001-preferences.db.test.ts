import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { NotificationPreferencesRepository } from '../src/modules/notifications/notification-preferences.repository.js';
import {
  NotificationPreferencesService,
  defaultsFor,
} from '../src/modules/notifications/notification-preferences.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * NOTIF-001 preferences against a real server. Three properties only the database proves:
 *
 * 1. **Absence reads as the defaults.** A person with no row reads
 *    `DEFAULT_NOTIFICATION_PREFERENCES` — every channel on, digest off, no quiet hours — so
 *    "never opened settings" and "saved the defaults" are one behaviour.
 * 2. **Upsert round-trips and replaces.** A save then a read returns what was stored (a
 *    `HH:MM` comes back as the column's `HH:MM:SS`); a second save updates the one row in
 *    place rather than adding a second, and the unique key `(organization_id, user_id)` is
 *    what makes that true.
 * 3. **Two people, and two studios, never mix.** One person's settings are invisible to
 *    another person in the same studio, and the same user id carries independent settings in
 *    two studios — the row is scoped by both `organization_id` and `user_id`.
 *
 * The route's authentication and own-only scoping are `notification-preferences.controller.
 * test.ts` (no database needed). This suite is UNEXECUTED in slice x54: the implementer does
 * not own `db-e2e.lock`.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: NotificationPreferencesService;

const contextFor = (
  organizationId: string,
  userId: string,
  membershipId: string,
  role: Role,
): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: '2026-09-19',
    correlationId: uuidv7(),
  });

const principalFor = (context: TenantContext, role: Role): Principal => ({
  userId: context.userId,
  organizationId: context.organizationId,
  kind: 'internal',
  role,
  membershipId: context.membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
});

let ownerCtx: TenantContext;
let owner: Principal;
let managerCtx: TenantContext;
let manager: Principal;
/** The twin tenant, entered as the *same person* as Northstar's owner, to isolate the org axis. */
let twinAsOwnerCtx: TenantContext;
let twinAsOwner: Principal;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new NotificationPreferencesService(tenant, new NotificationPreferencesRepository());

  ownerCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
    'owner',
  );
  owner = principalFor(ownerCtx, 'owner');

  managerCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.manager.id,
    world.northstar.manager.membershipId,
    'manager',
  );
  manager = principalFor(managerCtx, 'manager');

  // Same user id as Northstar's owner, but the twin organization. A prefs row is scoped by
  // both, so writing here and reading in Northstar must not cross.
  twinAsOwnerCtx = contextFor(
    world.twin.organizationId,
    world.northstar.owner.id,
    world.twin.owner.membershipId,
    'owner',
  );
  twinAsOwner = principalFor(twinAsOwnerCtx, 'owner');
});

afterAll(async () => {
  await db?.stop();
});

describe('NOTIF-001 notification preferences', () => {
  it('reads the defaults when the person has never saved', async () => {
    const view = await service.getPreferences(managerCtx, manager);
    // 55-18 (R18-d): an unsaved member gets the org profile's defaults, `calm` when unset; the
    // quiet-hours zone is the org's default timezone, so it is taken from the view itself.
    expect(view).toEqual(defaultsFor('calm', view.quietHoursTimezone));
  });

  it('round-trips an upsert and replaces the same row on a second save', async () => {
    const saved = await service.updatePreferences(ownerCtx, owner, {
      inAppEnabled: true,
      emailEnabled: false,
      digestFrequency: 'daily',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:30',
      quietHoursTimezone: 'Europe/London',
    });
    expect(saved).toEqual({
      inAppEnabled: true,
      emailEnabled: false,
      digestFrequency: 'daily',
      quietHoursStart: '22:00:00',
      quietHoursEnd: '07:30:00',
      quietHoursTimezone: 'Europe/London',
    });
    expect(await service.getPreferences(ownerCtx, owner)).toEqual(saved);

    // A second save is an update in place — one row, the new values, quiet hours cleared.
    const replaced = await service.updatePreferences(ownerCtx, owner, {
      inAppEnabled: false,
      emailEnabled: true,
      digestFrequency: 'weekly',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    });
    expect(replaced).toEqual({
      inAppEnabled: false,
      emailEnabled: true,
      digestFrequency: 'weekly',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    });
    const [counts] = await db.admin.query<RowDataPacket[]>(
      'select count(*) as n from notification_preferences where organization_id = ? and user_id = ?',
      [world.northstar.organizationId, world.northstar.owner.id],
    );
    expect(Number(counts[0]?.['n'])).toBe(1);
  });

  it('keeps one person’s settings out of another’s, in the same studio', async () => {
    await service.updatePreferences(ownerCtx, owner, {
      inAppEnabled: false,
      emailEnabled: false,
      digestFrequency: 'weekly',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    });
    // The manager, who saved nothing, still reads the defaults — not the owner's row. Since
    // 55-18 a member without a row reads the org profile (absent = calm), as the test above does.
    const managerView = await service.getPreferences(managerCtx, manager);
    expect(managerView).toEqual(defaultsFor('calm', managerView.quietHoursTimezone));
  });

  it('scopes by organization: the same user id has independent settings in two studios', async () => {
    await service.updatePreferences(ownerCtx, owner, {
      inAppEnabled: true,
      emailEnabled: false,
      digestFrequency: 'daily',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    });
    await service.updatePreferences(twinAsOwnerCtx, twinAsOwner, {
      inAppEnabled: false,
      emailEnabled: true,
      digestFrequency: 'weekly',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    });

    const inNorthstar = await service.getPreferences(ownerCtx, owner);
    const inTwin = await service.getPreferences(twinAsOwnerCtx, twinAsOwner);
    expect(inNorthstar.digestFrequency).toBe('daily');
    expect(inTwin.digestFrequency).toBe('weekly');
    expect(inNorthstar.emailEnabled).toBe(false);
    expect(inTwin.emailEnabled).toBe(true);
  });
});
