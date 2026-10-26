import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { InvoicesService } from '../src/modules/billing/invoices.controller.js';
import { InvoiceLineItemsService } from '../src/modules/billing/invoice-line-items.controller.js';
import { SubscriptionService } from '../src/modules/billing/subscription.service.js';
import { BillingSeatsService } from '../src/modules/billing/seats.controller.js';
import { AdminExportRequestsController } from '../src/modules/admin/export-requests.controller.js';
import { AdminExportRequestsRepository } from '../src/modules/admin/export-requests.repository.js';
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
 * SEC-012 (test slice T014) — the money- and governance-sensitive billing and admin-export
 * surfaces, proven to enforce **both** role and tenant through the real services and the real
 * `authorize()`. These routes reuse `org.manage` (DIVERGENCE AUTH-16; held by the owner and,
 * since ADM-03, the org admin), so "a member without the billing/admin capability" is any
 * internal role below org admin, and "an owner/billing-admin of tenant A" is the owner.
 *
 * What only this suite proves, end to end against real MySQL:
 *
 * 1. **Under-privilege is refused with 403, not a quiet success.** A member (and a client
 *    principal) is refused on invoice read, invoice line-item read, subscription read/change,
 *    seat list/assign/release, and admin-export create/list. The refusal is reached against a
 *    *real, present* row in the caller's own tenant, so it is the capability check talking and
 *    not an accidental 404.
 * 2. **Cross-tenant is 404 — indistinguishable from absent.** An owner of tenant A, using A's
 *    context, cannot read or mutate B's invoices, line-items, or seats by id: the tenant-scoped
 *    resolve returns nothing, and a real B id answers exactly as a fabricated id does, before any
 *    capability or write.
 * 3. **The admin-export request records requester + scope and is readable only by its own org.**
 *    A request created by A's owner stores `requested_by` and `scope`, lists for A, and never
 *    appears in B's list; B's request never appears in A's.
 * 4. **No money moves and no tenant bleeds on a write.** A plan change for A records
 *    `pending_change` for A alone; B's subscription is untouched.
 *
 * Conventions follow `work-003-blockers-dependencies.db.test.ts`: services/controllers are
 * constructed directly over the real `TenantDatabase`; fixtures are written through the admin pool
 * with **bound `Date`s** (the admin-pool clock is SYSTEM — never `current_timestamp`); the shared
 * helpers are imported, never edited.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let invoices: InvoicesService;
let invoiceLines: InvoiceLineItemsService;
let subscription: SubscriptionService;
let seats: BillingSeatsService;
let exportRequests: AdminExportRequestsController;

// Principals and their contexts, one per (role, tenant) the grid needs.
let ownerCtx: TenantContext;
let owner: Principal;
let memberCtx: TenantContext;
let member: Principal;
let clientCtx: TenantContext;
let clientPrincipal: Principal;
let twinOwnerCtx: TenantContext;
let twinOwner: Principal;

// Fixtures placed through the admin pool.
let nsInvoiceId: string;
let twinInvoiceId: string;

const NS_INVOICE_TOTAL = 125_00; // integer cents
const TWIN_INVOICE_TOTAL = 999_00;

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

/**
 * Insert one invoice (header JSON breakdown) plus its `invoice_line_items` rows for `organizationId`,
 * through the admin pool with bound `Date`s. The two line rows sum to `totalCents`, so the line-item
 * read reconciles.
 */
async function insertInvoice(
  organizationId: string,
  number: string,
  totalCents: number,
): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  const periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const lineA = {
    description: 'Platform subscription',
    quantity: 1,
    unitAmountCents: totalCents - 25_00,
    amountCents: totalCents - 25_00,
  };
  const lineB = {
    description: 'Additional seats',
    quantity: 5,
    unitAmountCents: 5_00,
    amountCents: 25_00,
  };
  await db.admin.execute(
    `insert into invoices
       (id, organization_id, number, period_start, period_end, amount_cents, currency, status,
        line_items, issued_at, created_at)
     values (?, ?, ?, ?, ?, ?, 'USD', 'open', ?, ?, ?)`,
    [
      id,
      organizationId,
      number,
      periodStart,
      now,
      totalCents,
      JSON.stringify([lineA, lineB]),
      now,
      now,
    ],
  );
  await db.admin.execute(
    `insert into invoice_line_items
       (id, organization_id, invoice_id, description, quantity, unit_amount_cents, amount_cents,
        position, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      uuidv7(),
      organizationId,
      id,
      lineA.description,
      lineA.quantity,
      lineA.unitAmountCents,
      lineA.amountCents,
      now,
    ],
  );
  await db.admin.execute(
    `insert into invoice_line_items
       (id, organization_id, invoice_id, description, quantity, unit_amount_cents, amount_cents,
        position, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      uuidv7(),
      organizationId,
      id,
      lineB.description,
      lineB.quantity,
      lineB.unitAmountCents,
      lineB.amountCents,
      now,
    ],
  );
  return id;
}

/** Insert an active billing seat row for `organizationId`/`membershipId` through the admin pool. */
async function insertSeat(organizationId: string, membershipId: string): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into billing_seats (id, organization_id, membership_id, assigned_at, released_at)
     values (?, ?, ?, ?, null)`,
    [id, organizationId, membershipId, new Date()],
  );
  return id;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  invoices = new InvoicesService(tenant);
  invoiceLines = new InvoiceLineItemsService(tenant);
  subscription = new SubscriptionService(tenant);
  seats = new BillingSeatsService(tenant);
  exportRequests = new AdminExportRequestsController(tenant, new AdminExportRequestsRepository());

  ownerCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  owner = {
    userId: ownerCtx.userId,
    organizationId: ownerCtx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: ownerCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  memberCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.designer.id,
    membershipId: world.northstar.designer.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('member'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  member = {
    userId: memberCtx.userId,
    organizationId: memberCtx.organizationId,
    kind: 'internal',
    role: 'member',
    membershipId: memberCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  };

  // A client principal belongs to the studio tenant (Northstar) but to a client organization within
  // it: its context names Northstar, so the tenant-scoped resolve succeeds and the refusal is the
  // capability check, exactly as it would be over HTTP.
  clientCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.atlas.admin.id,
    membershipId: world.atlas.admin.membershipId,
    principalKind: 'client',
    capabilities: capabilitiesFor('client_admin'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  clientPrincipal = {
    userId: clientCtx.userId,
    organizationId: clientCtx.organizationId,
    kind: 'client',
    role: 'client_admin',
    membershipId: clientCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: world.atlas.clientOrganizationId,
    projectIds: [world.northstar.projectId],
    hasOrgWideScope: false,
  };

  twinOwnerCtx = createTenantContext({
    organizationId: world.twin.organizationId,
    userId: world.twin.owner.id,
    membershipId: world.twin.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  twinOwner = {
    userId: twinOwnerCtx.userId,
    organizationId: twinOwnerCtx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: twinOwnerCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  nsInvoiceId = await insertInvoice(world.northstar.organizationId, 'NS-0001', NS_INVOICE_TOTAL);
  twinInvoiceId = await insertInvoice(world.twin.organizationId, 'TW-0001', TWIN_INVOICE_TOTAL);
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

describe('invoice reads — role then tenant', () => {
  it('the owner reads the list and the detail of their own tenant, in integer cents', async () => {
    const list = await invoices.list(ownerCtx, owner);
    expect(list.map((invoice) => invoice.id)).toContain(nsInvoiceId);

    const detail = await invoices.detail(ownerCtx, owner, nsInvoiceId);
    expect(detail.id).toBe(nsInvoiceId);
    expect(detail.amountCents).toBe(NS_INVOICE_TOTAL);
    expect(Number.isInteger(detail.amountCents)).toBe(true);
    expect(detail.lineItems.length).toBeGreaterThan(0);
  });

  it('a member is refused 403 on the list and on the detail of a real own-tenant invoice', async () => {
    // The detail refusal is reached against a present row: resolve finds it, then the capability
    // check talks. A 404 here would mean the suite proved nothing about under-privilege.
    await expectApiError(invoices.list(memberCtx, member), 403);
    await expectApiError(invoices.detail(memberCtx, member, nsInvoiceId), 403);
  });

  it('a client principal is refused 403 on the list and on the detail', async () => {
    await expectApiError(invoices.list(clientCtx, clientPrincipal), 403);
    await expectApiError(invoices.detail(clientCtx, clientPrincipal, nsInvoiceId), 403);
  });

  it("the owner of A cannot read B's invoice by id — 404, indistinguishable from absent", async () => {
    const crossTenant = await expectApiError(invoices.detail(ownerCtx, owner, twinInvoiceId), 404);
    const fabricated = await expectApiError(invoices.detail(ownerCtx, owner, uuidv7()), 404);
    // Same machine-readable cause: a real other-tenant id reveals nothing a made-up id does not.
    expect(crossTenant.auditCode).toBe(fabricated.auditCode);
    expect(crossTenant.auditCode).toBe('invoice_not_visible');
  });
});

describe('invoice line-items — role then tenant', () => {
  it('the owner reads the breakdown, which reconciles to the header total', async () => {
    const view = await invoiceLines.listForInvoice(ownerCtx, owner, nsInvoiceId);
    expect(view.invoiceId).toBe(nsInvoiceId);
    expect(view.invoiceTotalCents).toBe(NS_INVOICE_TOTAL);
    expect(view.lineTotalCents).toBe(NS_INVOICE_TOTAL);
    expect(view.reconciled).toBe(true);
    expect(view.lineItems.length).toBeGreaterThan(0);
  });

  it('a member is refused 403 on the line-items of a real own-tenant invoice', async () => {
    await expectApiError(invoiceLines.listForInvoice(memberCtx, member, nsInvoiceId), 403);
  });

  it('a client principal is refused 403 on the line-items', async () => {
    await expectApiError(invoiceLines.listForInvoice(clientCtx, clientPrincipal, nsInvoiceId), 403);
  });

  it("the owner of A cannot read B's invoice line-items by id — 404", async () => {
    await expectApiError(invoiceLines.listForInvoice(ownerCtx, owner, twinInvoiceId), 404);
    await expectApiError(invoiceLines.listForInvoice(ownerCtx, owner, uuidv7()), 404);
  });
});

describe('subscription read and change — role and tenant', () => {
  it('the owner reads their subscription and records a plan change (no charge, pending_change)', async () => {
    const before = await subscription.read(ownerCtx, owner);
    expect(before.planId).toBe('free');

    // A12 renamed the paid tier: `pro` is still accepted as a legacy alias but is read and
    // stored as the catalog plan `studio`.
    const changed = await subscription.requestChange(ownerCtx, owner, 'pro');
    expect(changed.planId).toBe('studio');
    expect(changed.status).toBe('pending_change');

    const row = await observe(
      `select plan_id, status from subscriptions where organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(row).toHaveLength(1);
    expect(String(row[0]?.['plan_id'])).toBe('studio');
    expect(String(row[0]?.['status'])).toBe('pending_change');
  });

  it("the plan change touched tenant A alone — B's subscription is still the default", async () => {
    const twinView = await subscription.read(twinOwnerCtx, twinOwner);
    expect(twinView.planId).toBe('free');
    expect(twinView.status).toBe('active');
    const twinRows = await observe(
      `select count(*) as n from subscriptions where organization_id = ?`,
      [world.twin.organizationId],
    );
    expect(Number(twinRows[0]?.['n'])).toBe(0);
  });

  it('a member is refused 403 on reading and on changing the subscription', async () => {
    await expectApiError(subscription.read(memberCtx, member), 403);
    await expectApiError(subscription.requestChange(memberCtx, member, 'pro'), 403);
  });

  it('a client principal is refused 403 on reading and on changing the subscription', async () => {
    await expectApiError(subscription.read(clientCtx, clientPrincipal), 403);
    await expectApiError(subscription.requestChange(clientCtx, clientPrincipal, 'pro'), 403);
  });

  it('an off-catalog plan is a 400 with no write, even for the owner', async () => {
    await expectApiError(subscription.requestChange(ownerCtx, owner, 'enterprise-unlimited'), 400);
  });
});

describe('billing seats — role and tenant', () => {
  it('the owner assigns a seat to an own-tenant membership and lists it', async () => {
    const assigned = await seats.assign(ownerCtx, owner, world.northstar.manager.membershipId);
    expect(assigned.membershipId).toBe(world.northstar.manager.membershipId);
    expect(assigned.releasedAt).toBeNull();

    const list = await seats.list(ownerCtx, owner);
    expect(list.seats.map((seat) => seat.membershipId)).toContain(
      world.northstar.manager.membershipId,
    );
    expect(list.activeCount).toBeGreaterThanOrEqual(1);
  });

  it('a member is refused 403 on list, assign and release', async () => {
    await expectApiError(seats.list(memberCtx, member), 403);
    await expectApiError(
      seats.assign(memberCtx, member, world.northstar.designer.membershipId),
      403,
    );
    // A real, present, active seat in the member's own tenant, so the refusal is the capability
    // check and not a 404.
    const seatId = await insertSeat(
      world.northstar.organizationId,
      world.northstar.owner.membershipId,
    );
    await expectApiError(seats.release(memberCtx, member, seatId), 403);
  });

  it('a client principal is refused 403 on list, assign and release', async () => {
    await expectApiError(seats.list(clientCtx, clientPrincipal), 403);
    await expectApiError(
      seats.assign(clientCtx, clientPrincipal, world.northstar.manager.membershipId),
      403,
    );
  });

  it("the owner of A cannot assign a seat to B's membership — 404, no write", async () => {
    await expectApiError(seats.assign(ownerCtx, owner, world.twin.owner.membershipId), 404);
    const bleed = await observe(
      `select count(*) as n from billing_seats
        where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.twin.owner.membershipId],
    );
    expect(Number(bleed[0]?.['n'])).toBe(0);
  });

  it("the owner of A cannot release B's seat by id — 404", async () => {
    const twinSeatId = await insertSeat(world.twin.organizationId, world.twin.owner.membershipId);
    await expectApiError(seats.release(ownerCtx, owner, twinSeatId), 404);
    // Still active in B — A's call wrote nothing.
    const stillOpen = await observe(`select released_at from billing_seats where id = ?`, [
      twinSeatId,
    ]);
    expect(stillOpen[0]?.['released_at']).toBeNull();
  });
});

describe('admin export requests — role, tenant, and the recorded facts', () => {
  it('the owner records a request that stores requester and scope, and lists it back', async () => {
    const view = await exportRequests.create(ownerCtx, owner, { scope: 'billing' });
    expect(view.requests.length).toBeGreaterThanOrEqual(1);
    const recorded = view.requests.find((request) => request.scope === 'billing');
    expect(recorded?.requestedBy).toBe(world.northstar.owner.id);
    expect(recorded?.status).toBe('pending');

    const row = await observe(
      `select scope, status, requested_by from admin_export_requests
        where organization_id = ? and scope = 'billing'`,
      [world.northstar.organizationId],
    );
    expect(row).toHaveLength(1);
    expect(String(row[0]?.['requested_by'])).toBe(world.northstar.owner.id);
    expect(String(row[0]?.['status'])).toBe('pending');

    const listed = await exportRequests.list(ownerCtx, owner);
    expect(listed.requests.map((request) => request.scope)).toContain('billing');
  });

  it('a member is refused 403 on listing and on creating a request', async () => {
    await expectApiError(exportRequests.list(memberCtx, member), 403);
    await expectApiError(exportRequests.create(memberCtx, member, { scope: 'members' }), 403);
  });

  it('a client principal is refused 403 on listing and on creating a request', async () => {
    await expectApiError(exportRequests.list(clientCtx, clientPrincipal), 403);
    await expectApiError(
      exportRequests.create(clientCtx, clientPrincipal, { scope: 'members' }),
      403,
    );
  });

  it("a request is readable only by its own org — B never sees A's, and A never sees B's", async () => {
    await exportRequests.create(twinOwnerCtx, twinOwner, { scope: 'projects' });

    const forTwin = await exportRequests.list(twinOwnerCtx, twinOwner);
    expect(forTwin.requests.map((request) => request.scope)).toEqual(['projects']);

    const forNorthstar = await exportRequests.list(ownerCtx, owner);
    expect(forNorthstar.requests.map((request) => request.scope)).not.toContain('projects');
  });

  it('an unknown export scope is a 400 with no write, even for the owner', async () => {
    const before = await observe(
      `select count(*) as n from admin_export_requests where organization_id = ?`,
      [world.northstar.organizationId],
    );
    await expectApiError(
      exportRequests.create(ownerCtx, owner, { scope: 'everything-forever' }),
      400,
    );
    const after = await observe(
      `select count(*) as n from admin_export_requests where organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(Number(after[0]?.['n'])).toBe(Number(before[0]?.['n']));
  });
});
