import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { SubscriptionRepository } from '../src/modules/billing/subscription.repository.js';
import { SubscriptionService } from '../src/modules/billing/subscription.service.js';
import { BillingSeatsRepository } from '../src/modules/billing/seats.repository.js';
import { BillingSeatsService } from '../src/modules/billing/seats.controller.js';
import { BillingProfileRepository } from '../src/modules/billing/profile.repository.js';
import { BillingContactsRepository } from '../src/modules/billing/contacts.repository.js';
import { BillingContactsService } from '../src/modules/billing/contacts.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

// These suites prove the paid behaviour; BILLING_MODE=beta_free (the default) is covered in
// src/modules/billing/billing-mode.test.ts.
beforeEach(() => {
  vi.stubEnv('BILLING_MODE', 'paid');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * BILLING-001 — the subscription / seat / profile / contacts half of Billing (module 19) against a
 * real local MySQL server (ADR-0002). This slice's four tables are NEW (0074 subscriptions, 0075
 * billing_seats, 0077 billing_profiles, 0082 billing_contacts) and their subscription/seat halves
 * were unproven against a real engine.
 *
 * What only this suite can prove — the engine's promises, not the service's recollection of them:
 *
 * 1. **Tenant isolation.** A tenant sees only its own subscription, seats, profile and contacts.
 *    The §11 adversarial twin (adjacent id, identical names) is the probe: a lost tenant predicate
 *    returns the twin's rows, so a twin read that comes back empty / 404 is the isolation holding.
 * 2. **One active subscription per org.** `uq_subscriptions_org` is the engine's guarantee: the
 *    upsert updates the one row rather than appending, and a direct second insert is refused.
 * 3. **One active seat per membership.** This is deliberately an *application* invariant, not a
 *    unique key (0075: a released row would collide), so the suite proves both halves — the service
 *    refuses a second active seat (409), and the engine does *not*. Assign/release round-trips.
 * 4. **No seat ceiling in this slice.** 0075 is explicit: enforcing a seat ceiling against a paid
 *    plan is Needs-Peter (real charging is out of scope). The suite pins the actual contract —
 *    assignments are recorded with no plan-based limit — so a later ceiling slice changes a test on
 *    purpose rather than silently contradicting this one.
 * 5. **Single-row-per-org profile**, and a billing contact that belongs to this org alone.
 * 6. **Identity is immutable at the engine.** The 0074/0075/0077/0082 BEFORE UPDATE triggers pin
 *    `organization_id` (and, for a seat, `membership_id` and `assigned_at`) for every credential —
 *    the control a direct SQL session cannot step around.
 *
 * Conventions mirror work-003-blockers-dependencies.db.test.ts: startTestDatabase/truncateAll,
 * seedTwoTenants, TenantDatabase guardMode 'enforce', createTenantContext/capabilitiesFor. Fixtures
 * are built in-test via the repositories and services; the admin pool observes what actually landed.
 * The admin pool clock is SYSTEM, so every admin-side row is dated from a bound `new Date(...)`.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let northstar: TenantContext;
let northstarOwner: Principal;
let twin: TenantContext;
let twinOwner: Principal;

const subscriptionRepo = new SubscriptionRepository();
const seatsRepo = new BillingSeatsRepository();
const profileRepo = new BillingProfileRepository();
const contactsRepo = new BillingContactsRepository();

let subscriptions: SubscriptionService;

/**
 * A pinned clock for the subscription service, so `nextBillAt` (the first of next month, UTC, on a
 * billed plan with no provider period yet) is an exact value rather than "whenever the suite ran".
 */
const FIXED_NOW = new Date('2026-10-23T12:00:00.000Z');
const NEXT_BILL_AT = '2026-11-01T00:00:00.000Z';
let seats: BillingSeatsService;
let contacts: BillingContactsService;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function ownerContext(
  organizationId: string,
  owner: { id: string; membershipId: string },
): {
  context: TenantContext;
  principal: Principal;
} {
  const context = createTenantContext({
    organizationId,
    userId: owner.id,
    membershipId: owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  const principal: Principal = {
    userId: owner.id,
    organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: owner.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
  return { context, principal };
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

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  ({ context: northstar, principal: northstarOwner } = ownerContext(
    world.northstar.organizationId,
    world.northstar.owner,
  ));
  ({ context: twin, principal: twinOwner } = ownerContext(
    world.twin.organizationId,
    world.twin.owner,
  ));

  subscriptions = new SubscriptionService(tenant, subscriptionRepo, () => FIXED_NOW);
  seats = new BillingSeatsService(tenant, seatsRepo);
  contacts = new BillingContactsService(tenant, contactsRepo);
});

afterAll(async () => {
  await db?.stop();
});

describe('the subscription — one row per org, and that row is this tenant alone', () => {
  it('a new org is the free/base tier until it has a row of its own', async () => {
    const view = await subscriptions.read(northstar, northstarOwner);
    // A12: Free has no list price, so no bill date; the four seeded internal members are counted
    // (Maya, Omar, Lina, Rania) and the client people, in client_memberships, are not.
    expect(view).toEqual({
      planId: 'free',
      billingMode: 'paid',
      status: 'active',
      currentPeriodEnd: null,
      internalPeopleCount: 4,
      nextBillAt: null,
      billingPeriod: 'monthly',
    });

    const row = await tenant.read(northstar, (runner) => subscriptionRepo.find(runner, northstar));
    expect(row).toBeNull();
  });

  it('a plan-change request upserts the one row to pending_change, and reads back as that', async () => {
    // A12 renamed `pro` to `studio`: the legacy id is still accepted and is stored as `studio`.
    const expected = {
      planId: 'studio',
      billingMode: 'paid',
      status: 'pending_change',
      currentPeriodEnd: null,
      internalPeopleCount: 4,
      nextBillAt: NEXT_BILL_AT,
      billingPeriod: 'monthly',
    };
    const changed = await subscriptions.requestChange(northstar, northstarOwner, 'pro');
    expect(changed).toEqual(expected);

    const again = await subscriptions.read(northstar, northstarOwner);
    expect(again).toEqual(expected);

    // The engine holds exactly one row for this org — the upsert updated in place — and it holds
    // the catalog id, never the legacy alias.
    const rows = await observe(`select id, plan_id from subscriptions where organization_id = ?`, [
      world.northstar.organizationId,
    ]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.['plan_id'])).toBe('studio');
  });

  it('a second change updates the same row, never appends a second', async () => {
    const before = await observe(`select id from subscriptions where organization_id = ?`, [
      world.northstar.organizationId,
    ]);
    const firstId = String(before[0]?.['id']);

    await subscriptions.requestChange(northstar, northstarOwner, 'business');
    const after = await observe(
      `select id, plan_id, status from subscriptions where organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(after).toHaveLength(1);
    expect(String(after[0]?.['id'])).toBe(firstId);
    expect(String(after[0]?.['plan_id'])).toBe('business');
    expect(String(after[0]?.['status'])).toBe('pending_change');
  });

  it('an off-catalog plan id is a 400 with no write', async () => {
    await expectApiError(
      subscriptions.requestChange(northstar, northstarOwner, 'enterprise-unlimited'),
      400,
    );
    const rows = await observe(`select plan_id from subscriptions where organization_id = ?`, [
      world.northstar.organizationId,
    ]);
    // Still the last valid plan; the refused change wrote nothing.
    expect(String(rows[0]?.['plan_id'])).toBe('business');
  });

  it('the twin sees nothing of Northstar — adjacent id, no leak', async () => {
    // Northstar has a row; the twin, probed through the same guarded repo, has none.
    const twinRow = await tenant.read(twin, (runner) => subscriptionRepo.find(runner, twin));
    expect(twinRow).toBeNull();
    const twinView = await subscriptions.read(twin, twinOwner);
    // The twin's own one owner is its whole count — none of Northstar's four people leak in.
    expect(twinView).toEqual({
      planId: 'free',
      billingMode: 'paid',
      status: 'active',
      currentPeriodEnd: null,
      internalPeopleCount: 1,
      nextBillAt: null,
      billingPeriod: 'monthly',
    });

    // And the twin, after taking a plan of its own, still does not collide with Northstar's row.
    await subscriptions.requestChange(twin, twinOwner, 'starter');
    const northstarAfter = await subscriptions.read(northstar, northstarOwner);
    expect(northstarAfter.planId).toBe('business');
    const twinAfter = await subscriptions.read(twin, twinOwner);
    expect(twinAfter.planId).toBe('starter');
  });

  it('the engine refuses a second subscription row for one org', async () => {
    const now = new Date();
    await expect(
      db.admin.execute(
        `insert into subscriptions (id, organization_id, plan_id, status, created_at, updated_at)
         values (?, ?, 'pro', 'active', ?, ?)`,
        [uuidv7(), world.northstar.organizationId, now, now],
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it('a subscription cannot be moved to another tenant — identity is pinned at the engine', async () => {
    await expect(
      db.admin.execute(`update subscriptions set organization_id = ? where organization_id = ?`, [
        world.twin.organizationId,
        world.northstar.organizationId,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('billing seats — assign, release, one active per membership', () => {
  it('assigns a seat, lists it, releases it, and the roster reflects each step', async () => {
    const empty = await seats.list(northstar, northstarOwner);
    expect(empty).toEqual({ seats: [], activeCount: 0 });

    const assigned = await seats.assign(
      northstar,
      northstarOwner,
      world.northstar.manager.membershipId,
    );
    expect(assigned.membershipId).toBe(world.northstar.manager.membershipId);
    expect(assigned.releasedAt).toBeNull();

    const afterAssign = await seats.list(northstar, northstarOwner);
    expect(afterAssign.activeCount).toBe(1);
    expect(afterAssign.seats[0]?.id).toBe(assigned.id);

    const released = await seats.release(northstar, northstarOwner, assigned.id);
    expect(released.id).toBe(assigned.id);
    expect(released.releasedAt).not.toBeNull();

    const afterRelease = await seats.list(northstar, northstarOwner);
    expect(afterRelease).toEqual({ seats: [], activeCount: 0 });

    // The released row is retained (soft close), not deleted — the history is the point of the table.
    const rows = await observe(
      `select released_at from billing_seats where organization_id = ? and id = ?`,
      [world.northstar.organizationId, assigned.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['released_at']).not.toBeNull();
  });

  it('refuses a second active seat for the same membership, then allows one after release', async () => {
    const first = await seats.assign(
      northstar,
      northstarOwner,
      world.northstar.designer.membershipId,
    );
    await expectApiError(
      seats.assign(northstar, northstarOwner, world.northstar.designer.membershipId),
      409,
    );

    // Releasing frees the membership to hold a new seat — a fresh row, the old one kept.
    await seats.release(northstar, northstarOwner, first.id);
    const second = await seats.assign(
      northstar,
      northstarOwner,
      world.northstar.designer.membershipId,
    );
    expect(second.id).not.toBe(first.id);
    expect(second.releasedAt).toBeNull();

    const held = await observe(
      `select count(*) as n from billing_seats where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.designer.membershipId],
    );
    expect(Number(held[0]?.['n'])).toBe(2);

    // The 409 is the application's promise, not a unique key: the engine itself accepts a second
    // active row for the membership (0075 keeps DELETE off and uses no partial unique key, because a
    // released row would collide). This is why the service check exists and why it is tested here.
    const now = new Date();
    await db.admin.execute(
      `insert into billing_seats (id, organization_id, membership_id, assigned_at, released_at)
       values (?, ?, ?, ?, null)`,
      [uuidv7(), world.northstar.organizationId, world.northstar.designer.membershipId, now],
    );
    const active = await observe(
      `select count(*) as n from billing_seats
         where organization_id = ? and membership_id = ? and released_at is null`,
      [world.northstar.organizationId, world.northstar.designer.membershipId],
    );
    expect(Number(active[0]?.['n'])).toBe(2);

    // Clean up the engine-level duplicate so later assertions see a single service-owned seat.
    await db.admin.execute(
      `update billing_seats set released_at = ?
         where organization_id = ? and membership_id = ? and id <> ? and released_at is null`,
      [now, world.northstar.organizationId, world.northstar.designer.membershipId, second.id],
    );
  });

  it('records assignments with no plan ceiling in this slice (ceiling is Needs-Peter, 0075)', async () => {
    // Three memberships, three active seats, no refusal on a count — the slice records the
    // assignment fact and counts against nothing paid. A later ceiling slice (real charging) will
    // change this expectation deliberately rather than discover it was never true.
    const roster = await seats.list(northstar, northstarOwner);
    const held = new Set(roster.seats.map((s) => s.membershipId));
    if (!held.has(world.northstar.owner.membershipId)) {
      await seats.assign(northstar, northstarOwner, world.northstar.owner.membershipId);
    }
    if (!held.has(world.northstar.manager.membershipId)) {
      await seats.assign(northstar, northstarOwner, world.northstar.manager.membershipId);
    }
    if (!held.has(world.northstar.designer.membershipId)) {
      await seats.assign(northstar, northstarOwner, world.northstar.designer.membershipId);
    }

    const full = await seats.list(northstar, northstarOwner);
    expect(full.activeCount).toBe(3);
    expect(new Set(full.seats.map((s) => s.membershipId))).toEqual(
      new Set([
        world.northstar.owner.membershipId,
        world.northstar.manager.membershipId,
        world.northstar.designer.membershipId,
      ]),
    );
  });

  it('a cross-tenant membership is a 404 with no write, never a seat on a neighbour', async () => {
    const before = await observe(
      `select count(*) as n from billing_seats where organization_id = ?`,
      [world.twin.organizationId],
    );
    const error = await expectApiError(
      seats.assign(northstar, northstarOwner, world.twin.owner.membershipId),
      404,
    );
    expect(error.code).toBe('not_found');

    // Nothing was written — not to the twin, not to Northstar against the foreign membership.
    const twinAfter = await observe(
      `select count(*) as n from billing_seats where organization_id = ?`,
      [world.twin.organizationId],
    );
    expect(Number(twinAfter[0]?.['n'])).toBe(Number(before[0]?.['n']));
    const dangling = await observe(
      `select count(*) as n from billing_seats where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.twin.owner.membershipId],
    );
    expect(Number(dangling[0]?.['n'])).toBe(0);
  });

  it("the twin sees none of Northstar's seats", async () => {
    const roster = await seats.list(twin, twinOwner);
    expect(roster).toEqual({ seats: [], activeCount: 0 });
  });

  it("the composite foreign key refuses a seat naming another tenant's membership", async () => {
    const now = new Date();
    await expect(
      db.admin.execute(
        `insert into billing_seats (id, organization_id, membership_id, assigned_at, released_at)
         values (?, ?, ?, ?, null)`,
        [uuidv7(), world.northstar.organizationId, world.twin.owner.membershipId, now],
      ),
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it("a seat's tenant, membership and grant time are immutable at the engine", async () => {
    const rows = await observe(
      `select id from billing_seats where organization_id = ? and membership_id = ? limit 1`,
      [world.northstar.organizationId, world.northstar.owner.membershipId],
    );
    const seatId = String(rows[0]?.['id']);
    const now = new Date();

    await expect(
      db.admin.execute(`update billing_seats set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        seatId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute(`update billing_seats set membership_id = ? where id = ?`, [
        world.northstar.manager.membershipId,
        seatId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute(`update billing_seats set assigned_at = ? where id = ?`, [now, seatId]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('the billing profile — one row per org, this tenant alone', () => {
  it('upserts the profile, reads it back, and a second save updates in place', async () => {
    const saved = await tenant.transaction(northstar, (tx) =>
      profileRepo.upsert(tx, northstar, {
        billingEmail: 'accounts@northstar.example',
        companyName: 'Northstar Studio',
        taxId: 'EG-100200300',
        address: {
          line1: '14 Nile Corniche',
          line2: null,
          city: 'Cairo',
          region: null,
          postalCode: '11511',
          country: 'EG',
        },
      }),
    );
    expect(saved.billingEmail).toBe('accounts@northstar.example');
    expect(saved.organizationId).toBe(world.northstar.organizationId);

    const resaved = await tenant.transaction(northstar, (tx) =>
      profileRepo.upsert(tx, northstar, {
        billingEmail: 'finance@northstar.example',
        companyName: 'Northstar Studio Ltd',
        taxId: 'EG-100200300',
        address: {
          line1: '14 Nile Corniche',
          line2: 'Floor 3',
          city: 'Cairo',
          region: null,
          postalCode: '11511',
          country: 'EG',
        },
      }),
    );
    expect(resaved.id).toBe(saved.id);
    expect(resaved.billingEmail).toBe('finance@northstar.example');
    expect(resaved.companyName).toBe('Northstar Studio Ltd');

    const rows = await observe(`select id from billing_profiles where organization_id = ?`, [
      world.northstar.organizationId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("the twin has no profile of its own and cannot see Northstar's", async () => {
    const twinRow = await tenant.read(twin, (runner) => profileRepo.find(runner, twin));
    expect(twinRow).toBeNull();
  });

  it('the engine refuses a second profile row for one org', async () => {
    const now = new Date();
    await expect(
      db.admin.execute(
        `insert into billing_profiles
           (id, organization_id, billing_email, company_name, tax_id, address_json, created_at, updated_at)
         values (?, ?, null, null, null, ?, ?, ?)`,
        [uuidv7(), world.northstar.organizationId, JSON.stringify({}), now, now],
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it('a profile cannot be moved to another tenant', async () => {
    await expect(
      db.admin.execute(
        `update billing_profiles set organization_id = ? where organization_id = ?`,
        [world.twin.organizationId, world.northstar.organizationId],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('billing contacts — a contact belongs to this org only', () => {
  let northstarContactId: string;

  it('adds a contact, lists it, and it carries the tenant from the context', async () => {
    const added = await contacts.add(northstar, northstarOwner, {
      name: 'Omar Adel',
      email: 'omar.adel@northstar.example',
      role: 'Accounts payable',
    });
    northstarContactId = added.id;
    expect(added.name).toBe('Omar Adel');
    expect(added.role).toBe('Accounts payable');

    const list = await contacts.list(northstar, northstarOwner);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(northstarContactId);

    const rows = await observe(`select organization_id from billing_contacts where id = ?`, [
      northstarContactId,
    ]);
    expect(String(rows[0]?.['organization_id'])).toBe(world.northstar.organizationId);
  });

  it("the twin cannot see, find or remove Northstar's contact", async () => {
    const twinList = await contacts.list(twin, twinOwner);
    expect(twinList).toEqual([]);

    const foundByTwin = await tenant.read(twin, (runner) =>
      contactsRepo.findById(runner, twin, northstarContactId),
    );
    expect(foundByTwin).toBeNull();

    // A cross-tenant remove is the same 404 an absent id gives, and it deletes nothing.
    await expectApiError(contacts.remove(twin, twinOwner, northstarContactId), 404);
    const still = await observe(`select count(*) as n from billing_contacts where id = ?`, [
      northstarContactId,
    ]);
    expect(Number(still[0]?.['n'])).toBe(1);
  });

  it('a card/PAN-shaped value in a field is refused with no write', async () => {
    const before = await observe(
      `select count(*) as n from billing_contacts where organization_id = ?`,
      [world.northstar.organizationId],
    );
    // A Luhn-valid 16-digit test PAN in the name field.
    await expectApiError(
      contacts.add(northstar, northstarOwner, {
        name: '4111 1111 1111 1111',
        email: 'ap@northstar.example',
        role: null,
      }),
      400,
    );
    const after = await observe(
      `select count(*) as n from billing_contacts where organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(Number(after[0]?.['n'])).toBe(Number(before[0]?.['n']));
  });

  it('the owner removes its own contact; a second remove is a 404', async () => {
    const removed = await contacts.remove(northstar, northstarOwner, northstarContactId);
    expect(removed.id).toBe(northstarContactId);
    expect(await contacts.list(northstar, northstarOwner)).toEqual([]);

    await expectApiError(contacts.remove(northstar, northstarOwner, northstarContactId), 404);
  });

  it('a contact cannot be moved to another tenant', async () => {
    const added = await contacts.add(northstar, northstarOwner, {
      name: 'Maya Hassan',
      email: 'maya.hassan@northstar.example',
      role: 'Owner',
    });
    await expect(
      db.admin.execute(`update billing_contacts set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        added.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
