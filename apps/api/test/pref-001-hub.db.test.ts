import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { PreferencesController } from '../src/modules/preferences/preferences.controller.js';
import { PreferencesRepository } from '../src/modules/preferences/preferences.repository.js';
import { A11yPreferencesController } from '../src/modules/preferences/a11y.controller.js';
import { A11yPreferencesRepository } from '../src/modules/preferences/a11y.repository.js';
import { QuietHoursController } from '../src/modules/preferences/quiet-hours.controller.js';
import { QuietHoursRepository } from '../src/modules/preferences/quiet-hours.repository.js';
import { isWithinQuietHours } from '../src/modules/preferences/quiet-hours.service.js';
import type { QuietHours } from '../src/common/database/schema.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PREF-001 — the Preferences & accessibility hub against a real MySQL (module 20, migrations
 * 0078 user_preferences, 0079 a11y_preferences, 0093 pref_quiet_hours). The hub spans three
 * sibling per-member stores, and this suite proves the properties they share and the one each
 * holds alone — things only the database (its composite foreign keys, unique keys and
 * immutability triggers) can show, exercised through the real controllers and repositories.
 *
 * 1. **Scoped per (org, membership).** The route can only ever name the acting membership, so one
 *    member reads and writes their own row and no other even inside one tenant; and the engine
 *    makes a cross-tenant row *unexpressible* — the composite FK `(organization_id, membership_id)
 *    → memberships (organization_id, id)` refuses a membership id borrowed from the adversarial
 *    twin, whose organization id differs from Northstar's in the final hex digit only.
 * 2. **One row per member per table.** A second save updates in place (the upsert), and a direct
 *    second insert under the same `(organization_id, membership_id)` is refused by the unique key.
 * 3. **Closed vocabularies validated.** theme / density / locale, the a11y font scale and toggles,
 *    and the quiet-hours window are each checked against their allowlist: a bad value is a 400 and
 *    nothing is written — the prior row stands.
 * 4. **a11y toggles persist and identity is immutable.** The three toggles round-trip; the BEFORE
 *    UPDATE trigger pins organization_id / membership_id at the engine.
 * 5. **Quiet hours persist and classify a bound instant.** The window round-trips and
 *    `isWithinQuietHours` classifies a bound `new Date(...)` in the stored zone — wrap-around,
 *    plain, weekday filter, disabled and zero-length — the pure answer notification quiet-hour
 *    suppression reads. The clock is always a bound Date, never the (SYSTEM) admin-pool clock.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let prefs: PreferencesController;
let a11y: A11yPreferencesController;
let quiet: QuietHoursController;

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
  hasOrgWideScope: role === 'owner',
});

let ownerCtx: TenantContext;
let owner: Principal;
/** A second member of the SAME studio — the own-principal boundary runs between these two. */
let designerCtx: TenantContext;
let designer: Principal;
/** The adversarial twin, entered as its own owner: adjacent org id, same display name. */
let twinCtx: TenantContext;
let twin: Principal;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected a ${status} refusal and got success`);
}

/** A bound UTC instant for a wall-clock in Asia/Dubai (UTC+4, no DST — deterministic under test). */
function dubai(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month, day, hour - 4, minute));
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  prefs = new PreferencesController(tenant, new PreferencesRepository());
  a11y = new A11yPreferencesController(tenant, new A11yPreferencesRepository());
  quiet = new QuietHoursController(tenant, new QuietHoursRepository());

  ownerCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
    'owner',
  );
  owner = principalFor(ownerCtx, 'owner');

  designerCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.designer.id,
    world.northstar.designer.membershipId,
    'member',
  );
  designer = principalFor(designerCtx, 'member');

  twinCtx = contextFor(
    world.twin.organizationId,
    world.twin.owner.id,
    world.twin.owner.membershipId,
    'owner',
  );
  twin = principalFor(twinCtx, 'owner');
});

afterAll(async () => {
  await db?.stop();
});

describe('display preferences — scoped per (org, membership)', () => {
  it('each member reads only their own row, and absence is the defaults', async () => {
    // Never-saved reads the shipped defaults, so "never opened settings" is not an error.
    expect(await prefs.get(designerCtx, designer)).toEqual({
      theme: 'system',
      locale: 'en',
      density: 'comfortable',
    });

    // Two members of one studio save different settings through their own contexts.
    const ownerView = await prefs.put(ownerCtx, owner, {
      theme: 'dark',
      locale: 'fr',
      density: 'compact',
    });
    expect(ownerView).toEqual({ theme: 'dark', locale: 'fr', density: 'compact' });

    const designerView = await prefs.put(designerCtx, designer, {
      theme: 'light',
      locale: 'en-GB',
      density: 'comfortable',
    });
    expect(designerView).toEqual({ theme: 'light', locale: 'en-GB', density: 'comfortable' });

    // Each reads back their own, not the other's — the route can only name the acting membership.
    expect(await prefs.get(ownerCtx, owner)).toEqual({
      theme: 'dark',
      locale: 'fr',
      density: 'compact',
    });
    expect(await prefs.get(designerCtx, designer)).toEqual({
      theme: 'light',
      locale: 'en-GB',
      density: 'comfortable',
    });

    // Exactly one row per membership in this studio.
    const rows = await observe(
      `select membership_id from user_preferences where organization_id = ? order by membership_id`,
      [world.northstar.organizationId],
    );
    expect(rows).toHaveLength(2);
    const members = rows.map((row) => String(row['membership_id'])).sort();
    expect(members).toEqual(
      [world.northstar.owner.membershipId, world.northstar.designer.membershipId].sort(),
    );
  });

  it("the twin tenant's row is invisible, and a borrowed membership id is unexpressible", async () => {
    // The twin saves its own settings. Its owner shares Northstar's owner's display name and sits
    // on an org id one hex digit away — exactly the collision §11's corpus is built to catch.
    await prefs.put(twinCtx, twin, { theme: 'dark', locale: 'de', density: 'compact' });

    // Northstar's owner still reads Northstar's row, never the twin's.
    expect(await prefs.get(ownerCtx, owner)).toEqual({
      theme: 'dark',
      locale: 'fr',
      density: 'compact',
    });

    // The twin's row lives only under the twin org, keyed to the twin's own membership.
    const twinRows = await observe(
      `select membership_id from user_preferences where organization_id = ?`,
      [world.twin.organizationId],
    );
    expect(twinRows).toHaveLength(1);
    expect(String(twinRows[0]?.['membership_id'])).toBe(world.twin.owner.membershipId);

    // The engine makes a cross-tenant preference impossible: a Northstar membership id under the
    // twin org (and the reverse) fails the composite FK into memberships (organization_id, id).
    const prefsJson = JSON.stringify({ theme: 'system', locale: 'en', density: 'comfortable' });
    await expect(
      db.admin.execute(
        `insert into user_preferences (id, organization_id, membership_id, prefs_json)
         values (?, ?, ?, ?)`,
        [uuidv7(), world.twin.organizationId, world.northstar.owner.membershipId, prefsJson],
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
    await expect(
      db.admin.execute(
        `insert into user_preferences (id, organization_id, membership_id, prefs_json)
         values (?, ?, ?, ?)`,
        [uuidv7(), world.northstar.organizationId, world.twin.owner.membershipId, prefsJson],
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('a second save updates in place; a duplicate insert is refused by the unique key', async () => {
    // The upsert replaces, it does not accumulate.
    await prefs.put(ownerCtx, owner, { theme: 'light', locale: 'en', density: 'comfortable' });
    expect(await prefs.get(ownerCtx, owner)).toEqual({
      theme: 'light',
      locale: 'en',
      density: 'comfortable',
    });
    const rows = await observe(
      `select id from user_preferences where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.owner.membershipId],
    );
    expect(rows).toHaveLength(1);

    // A direct second row for the same member collides on uq_user_preferences_org_membership.
    await expect(
      db.admin.execute(
        `insert into user_preferences (id, organization_id, membership_id, prefs_json)
         values (?, ?, ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.owner.membershipId,
          JSON.stringify({ theme: 'dark', locale: 'de', density: 'compact' }),
        ],
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it('validates theme, density and locale against their closed vocabularies', async () => {
    // The persisted-before state the invalid writes must leave untouched.
    const before = await prefs.get(ownerCtx, owner);

    const badTheme = await expectApiError(
      prefs.put(ownerCtx, owner, { theme: 'ultraviolet', locale: 'en', density: 'comfortable' }),
      400,
    );
    expect(badTheme.details?.map((detail) => detail.field)).toContain('theme');

    const badLocale = await expectApiError(
      prefs.put(ownerCtx, owner, { theme: 'dark', locale: 'xx', density: 'comfortable' }),
      400,
    );
    expect(badLocale.details?.map((detail) => detail.field)).toContain('locale');

    const badDensity = await expectApiError(
      prefs.put(ownerCtx, owner, { theme: 'dark', locale: 'en', density: 'roomy' }),
      400,
    );
    expect(badDensity.details?.map((detail) => detail.field)).toContain('density');

    // Nothing was written: the row still holds what it held before the three refusals.
    expect(await prefs.get(ownerCtx, owner)).toEqual(before);
  });
});

describe('accessibility preferences — toggles persist, identity is immutable', () => {
  it('round-trips the three toggles and replaces in place', async () => {
    expect(await a11y.get(ownerCtx, owner)).toEqual({
      fontScale: 'md',
      reduceMotion: false,
      highContrast: false,
    });

    const saved = await a11y.put(ownerCtx, owner, {
      fontScale: 'xl',
      reduceMotion: true,
      highContrast: true,
    });
    expect(saved).toEqual({ fontScale: 'xl', reduceMotion: true, highContrast: true });
    expect(await a11y.get(ownerCtx, owner)).toEqual({
      fontScale: 'xl',
      reduceMotion: true,
      highContrast: true,
    });

    // A second save turns the toggles back off and updates the one row rather than adding another.
    await a11y.put(ownerCtx, owner, {
      fontScale: 'sm',
      reduceMotion: false,
      highContrast: false,
    });
    expect(await a11y.get(ownerCtx, owner)).toEqual({
      fontScale: 'sm',
      reduceMotion: false,
      highContrast: false,
    });
    const rows = await observe(
      `select id from a11y_preferences where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.owner.membershipId],
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects an off-list font scale and a non-boolean toggle, writing nothing', async () => {
    const before = await a11y.get(ownerCtx, owner);

    const badScale = await expectApiError(
      a11y.put(ownerCtx, owner, { fontScale: 'huge', reduceMotion: true, highContrast: false }),
      400,
    );
    expect(badScale.details?.map((detail) => detail.field)).toContain('fontScale');

    const badBool = await expectApiError(
      a11y.put(ownerCtx, owner, { fontScale: 'md', reduceMotion: 'yes', highContrast: false }),
      400,
    );
    expect(badBool.details?.map((detail) => detail.field)).toContain('reduceMotion');

    expect(await a11y.get(ownerCtx, owner)).toEqual(before);
  });

  it('pins organization_id and membership_id at the engine', async () => {
    const rows = await observe(
      `select id from a11y_preferences where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.owner.membershipId],
    );
    const id = String(rows[0]?.['id']);

    await expect(
      db.admin.execute(`update a11y_preferences set membership_id = ? where id = ?`, [
        world.northstar.designer.membershipId,
        id,
      ]),
    ).rejects.toThrow(/is immutable/);
    await expect(
      db.admin.execute(`update a11y_preferences set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        id,
      ]),
    ).rejects.toThrow(/is immutable/);
  });
});

describe('quiet hours — window persists and classifies a bound instant', () => {
  it('round-trips a wrap-around window and refuses a borrowed membership id', async () => {
    const view = await quiet.put(ownerCtx, owner, {
      enabled: true,
      startTime: '22:00',
      endTime: '07:00',
      timezone: 'Asia/Dubai',
      days: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(view).toEqual({
      enabled: true,
      startTime: '22:00',
      endTime: '07:00',
      timezone: 'Asia/Dubai',
      days: [0, 1, 2, 3, 4, 5, 6],
    });

    const stored = await observe(
      `select quiet_json from pref_quiet_hours where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.owner.membershipId],
    );
    expect(stored).toHaveLength(1);
    const raw = stored[0]?.['quiet_json'];
    const settings = (typeof raw === 'string' ? JSON.parse(raw) : raw) as QuietHours;
    expect(settings.timezone).toBe('Asia/Dubai');

    // A quiet-hours row cannot cite a membership from another studio either (composite FK).
    await expect(
      db.admin.execute(
        `insert into pref_quiet_hours (id, organization_id, membership_id, quiet_json)
         values (?, ?, ?, ?)`,
        [
          uuidv7(),
          world.twin.organizationId,
          world.northstar.owner.membershipId,
          JSON.stringify(settings),
        ],
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('classifies a bound instant against the persisted wrap-around window', async () => {
    // Read the window back the way the notification path would, then classify bound instants.
    const window = await quiet.get(ownerCtx, owner);

    // Monday 2026-01-05, Asia/Dubai. The window is 22:00–07:00, wrapping midnight, every weekday.
    expect(isWithinQuietHours(window, dubai(2026, 0, 5, 23, 30))).toBe(true); // late evening: inside
    expect(isWithinQuietHours(window, dubai(2026, 0, 5, 3, 0))).toBe(true); // small hours: inside
    expect(isWithinQuietHours(window, dubai(2026, 0, 5, 12, 0))).toBe(false); // midday: outside
    expect(isWithinQuietHours(window, dubai(2026, 0, 5, 7, 0))).toBe(false); // end is exclusive
  });

  it('honours a plain window, the weekday filter, disabled and zero-length', async () => {
    // Plain (non-wrapping) weekday-only window: 09:00–17:00, Monday–Friday.
    const weekdays = await quiet.put(ownerCtx, owner, {
      enabled: true,
      startTime: '09:00',
      endTime: '17:00',
      timezone: 'Asia/Dubai',
      days: [1, 2, 3, 4, 5],
    });
    expect(isWithinQuietHours(weekdays, dubai(2026, 0, 5, 12, 0))).toBe(true); // Mon midday: inside
    expect(isWithinQuietHours(weekdays, dubai(2026, 0, 5, 8, 0))).toBe(false); // Mon before start
    expect(isWithinQuietHours(weekdays, dubai(2026, 0, 4, 12, 0))).toBe(false); // Sun excluded by days

    // Disabled is never active, whatever the clock says.
    const disabled: QuietHours = { ...weekdays, enabled: false };
    expect(isWithinQuietHours(disabled, dubai(2026, 0, 5, 12, 0))).toBe(false);

    // A zero-length window (start === end) is never active.
    const zero: QuietHours = { ...weekdays, startTime: '09:00', endTime: '09:00' };
    expect(isWithinQuietHours(zero, dubai(2026, 0, 5, 9, 0))).toBe(false);
  });

  it('validates the window shape, writing nothing on a bad body', async () => {
    const before = await quiet.get(ownerCtx, owner);

    const badTime = await expectApiError(
      quiet.put(ownerCtx, owner, {
        enabled: true,
        startTime: '25:00',
        endTime: '07:00',
        timezone: 'Asia/Dubai',
        days: [1],
      }),
      400,
    );
    expect(badTime.details?.map((detail) => detail.field)).toContain('startTime');

    const badZone = await expectApiError(
      quiet.put(ownerCtx, owner, {
        enabled: true,
        startTime: '22:00',
        endTime: '07:00',
        timezone: 'Mars/Olympus',
        days: [1],
      }),
      400,
    );
    expect(badZone.details?.map((detail) => detail.field)).toContain('timezone');

    const badDay = await expectApiError(
      quiet.put(ownerCtx, owner, {
        enabled: true,
        startTime: '22:00',
        endTime: '07:00',
        timezone: 'Asia/Dubai',
        days: [7],
      }),
      400,
    );
    expect(badDay.details?.map((detail) => detail.field)).toContain('days');

    expect(await quiet.get(ownerCtx, owner)).toEqual(before);
  });
});
