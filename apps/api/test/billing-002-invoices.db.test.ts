import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { InvoicesRepository } from '../src/modules/billing/invoices.repository.js';
import { InvoiceLineItemsRepository } from '../src/modules/billing/invoice-line-items.repository.js';
import { CreditsRepository } from '../src/modules/billing/credits.repository.js';
import { DiscountsRepository } from '../src/modules/billing/discounts.repository.js';
import { UsageAlertsRepository } from '../src/modules/billing/usage-alerts.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * T004 — Billing invoices / line-items / credits / discounts / usage-alerts against a real MySQL.
 *
 * The invoice half of module 19 (0076 invoices, 0099 invoice_line_items, 0100 billing_credits,
 * 0197 billing_discounts, 0083 billing_usage_alerts). This suite is deliberately disjoint from the
 * subscription half (T003): no plan, seat or subscription table is touched here.
 *
 * What only a real-engine suite can prove:
 *
 * 1. **Tenant isolation is the composite key, not the application.** The adversarial twin seeds an
 *    invoice with the *same human number* as Northstar's; a read that lost its `organization_id`
 *    predicate would return both. The list sees one tenant's rows, and a cross-tenant id resolves to
 *    `null` (the controller's 404) rather than another studio's billing record.
 * 2. **A line cannot be fathered by an invoice in another org.** `(organization_id, invoice_id)`
 *    references `invoices (organization_id, id)` (0099), so a line in Northstar's tenant that names
 *    the twin's invoice id is refused by the engine — the FK, not a hopeful app check.
 * 3. **The header total reconciles to the summed lines** — 0099's stated invariant, read back through
 *    the two repositories a real client uses.
 * 4. **Identity is immutable at the engine.** An invoice's `organization_id`, and a line's
 *    `organization_id`/`invoice_id`, cannot be re-pointed even by a direct SQL session — the
 *    `BEFORE UPDATE` triggers (0076/0099), which ADR-0001's app-side layers cannot provide. (The
 *    runtime's broader read-only posture on these tables is grant-enforced — SELECT, no write grant —
 *    and is the separate least-privilege proof, invisible under the admin suite.)
 * 5. **A credit, a discount and a usage-alert belong to one tenant only**, created through the real
 *    repositories: the twin never sees them, and a cross-tenant id resolves to `null`.
 * 6. **The usage-alert threshold round-trips**, is one-rule-per-metric at the engine
 *    (`uq_billing_usage_alerts_org_metric`), and its `metric` is immutable (0083 trigger).
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let northstar: TenantContext;
let twin: TenantContext;

const invoices = new InvoicesRepository();
const lineItems = new InvoiceLineItemsRepository();
const credits = new CreditsRepository();
const discounts = new DiscountsRepository();
const usageAlerts = new UsageAlertsRepository();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

interface SeedLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly amountCents: number;
  readonly position: number;
}

interface SeedInvoice {
  readonly organizationId: string;
  readonly number: string;
  readonly amountCents: number;
  readonly currency?: string;
  readonly status?: 'paid' | 'open' | 'void';
  /** A bound instant — never the admin connection's SYSTEM clock (dates must be deterministic). */
  readonly issuedAt: Date;
  readonly lines: readonly SeedLine[];
}

/**
 * Seed one invoice and its lines through the admin connection. These tables are read-only from the
 * application (no insert route, no write grant), so the fixtures are built with raw SQL — the same
 * way the subscription lifecycle or the seed would produce them. Every timestamp is a *bound* Date,
 * because the admin pool's clock is SYSTEM-local, not UTC, and ordering must not drift with it.
 */
async function seedInvoice(invoice: SeedInvoice): Promise<string> {
  const id = uuidv7();
  const issued = invoice.issuedAt;
  const periodStart = new Date(issued.getTime() - 30 * 24 * 60 * 60 * 1000);
  const lineDefs = invoice.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitAmountCents: line.unitAmountCents,
    amountCents: line.amountCents,
  }));

  await db.admin.execute(
    `insert into invoices
       (id, organization_id, number, period_start, period_end, amount_cents, currency, status,
        line_items, issued_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      invoice.organizationId,
      invoice.number,
      periodStart,
      issued,
      invoice.amountCents,
      invoice.currency ?? 'USD',
      invoice.status ?? 'open',
      JSON.stringify(lineDefs),
      issued,
      issued,
    ],
  );

  for (const line of invoice.lines) {
    await db.admin.execute(
      `insert into invoice_line_items
         (id, organization_id, invoice_id, description, quantity, unit_amount_cents, amount_cents,
          position, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        invoice.organizationId,
        id,
        line.description,
        line.quantity,
        line.unitAmountCents,
        line.amountCents,
        line.position,
        issued,
      ],
    );
  }

  return id;
}

function contextFor(
  organizationId: string,
  user: { readonly id: string; readonly membershipId: string },
): TenantContext {
  return createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
}

// A fixed base instant so seeded ordering is deterministic regardless of the SYSTEM clock.
const BASE = new Date('2026-07-01T12:00:00.000Z');

let northstarInvoiceId: string;
let twinInvoiceId: string;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  northstar = contextFor(world.northstar.organizationId, world.northstar.owner);
  twin = contextFor(world.twin.organizationId, world.twin.owner);

  // Northstar's invoice: three lines that reconcile to 18_000 cents.
  northstarInvoiceId = await seedInvoice({
    organizationId: world.northstar.organizationId,
    number: 'INV-2026-0001',
    amountCents: 18_000,
    issuedAt: new Date(BASE.getTime() + 2 * 24 * 60 * 60 * 1000),
    lines: [
      {
        description: 'Pro plan — Jul 2026',
        quantity: 1,
        unitAmountCents: 10_000,
        amountCents: 10_000,
        position: 0,
      },
      {
        description: 'Extra seats (2)',
        quantity: 2,
        unitAmountCents: 3_000,
        amountCents: 6_000,
        position: 1,
      },
      {
        description: 'Storage overage',
        quantity: 1,
        unitAmountCents: 2_000,
        amountCents: 2_000,
        position: 2,
      },
    ],
  });

  // The twin issues an invoice with the SAME human number — a lost tenant predicate would collide.
  twinInvoiceId = await seedInvoice({
    organizationId: world.twin.organizationId,
    number: 'INV-2026-0001',
    amountCents: 4_200,
    status: 'paid',
    issuedAt: new Date(BASE.getTime() + 1 * 24 * 60 * 60 * 1000),
    lines: [
      {
        description: 'Starter plan — Jul 2026',
        quantity: 1,
        unitAmountCents: 4_200,
        amountCents: 4_200,
        position: 0,
      },
    ],
  });
});

afterAll(async () => {
  await db?.stop();
});

describe('invoice history is tenant-scoped', () => {
  it('a tenant lists only its own invoices, though the twin shares the number', async () => {
    const mine = await tenant.read(northstar, (tx) => invoices.list(tx, northstar, { limit: 100 }));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.id).toBe(northstarInvoiceId);
    expect(mine[0]?.number).toBe('INV-2026-0001');
    expect(mine[0]?.amountCents).toBe(18_000);
    expect(mine.map((row) => row.id)).not.toContain(twinInvoiceId);

    const theirs = await tenant.read(twin, (tx) => invoices.list(tx, twin, { limit: 100 }));
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.id).toBe(twinInvoiceId);
    expect(theirs[0]?.amountCents).toBe(4_200);
  });

  it("the twin's invoice id resolves to null for Northstar, not to the twin's row", async () => {
    // The row genuinely exists under the twin — so this is isolation, not a missing row.
    const reallyExists = await tenant.read(twin, (tx) =>
      invoices.findById(tx, twin, twinInvoiceId),
    );
    expect(reallyExists?.id).toBe(twinInvoiceId);

    const crossed = await tenant.read(northstar, (tx) =>
      invoices.findById(tx, northstar, twinInvoiceId),
    );
    expect(crossed).toBeNull();

    const own = await tenant.read(northstar, (tx) =>
      invoices.findById(tx, northstar, northstarInvoiceId),
    );
    expect(own?.id).toBe(northstarInvoiceId);
  });
});

describe('invoice line items', () => {
  it('lists one invoice’s lines in display order, within the tenant', async () => {
    const lines = await tenant.read(northstar, (tx) =>
      lineItems.listByInvoice(tx, northstar, northstarInvoiceId),
    );
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.position)).toEqual([0, 1, 2]);
    expect(lines[0]?.description).toBe('Pro plan — Jul 2026');
    expect(lines.every((line) => line.invoiceId === northstarInvoiceId)).toBe(true);
  });

  it("the twin's invoice id yields no lines for Northstar", async () => {
    // The lines exist under the twin.
    const twinLines = await tenant.read(twin, (tx) =>
      lineItems.listByInvoice(tx, twin, twinInvoiceId),
    );
    expect(twinLines).toHaveLength(1);

    // But Northstar, asking for the twin's invoice id, sees nothing (the predicate is on org + id).
    const crossed = await tenant.read(northstar, (tx) =>
      lineItems.listByInvoice(tx, northstar, twinInvoiceId),
    );
    expect(crossed).toHaveLength(0);
  });

  it('refuses a line fathered by an invoice in another org (the composite FK)', async () => {
    // Northstar's tenant, naming the TWIN's invoice id: (northstar_org, twin_invoice) is not a row
    // in `invoices`, so the engine's composite foreign key rejects the insert outright.
    await expect(
      db.admin.execute(
        `insert into invoice_line_items
           (id, organization_id, invoice_id, description, quantity, unit_amount_cents, amount_cents,
            position, created_at)
         values (?, ?, ?, 'smuggled', 1, 1, 1, 0, ?)`,
        [uuidv7(), world.northstar.organizationId, twinInvoiceId, BASE],
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('the header total reconciles to the summed lines (0099 invariant)', async () => {
    const header = await tenant.read(northstar, (tx) =>
      invoices.findById(tx, northstar, northstarInvoiceId),
    );
    const lines = await tenant.read(northstar, (tx) =>
      lineItems.listByInvoice(tx, northstar, northstarInvoiceId),
    );
    const summed = lines.reduce((total, line) => total + line.amountCents, 0);
    expect(summed).toBe(header?.amountCents);
    // Each line's own total is its quantity × unit price — exact, in integer minor units.
    for (const line of lines) {
      expect(line.amountCents).toBe(line.quantity * line.unitAmountCents);
    }
  });
});

describe('invoice identity is immutable at the engine', () => {
  it("refuses re-pointing an invoice's organization_id", async () => {
    await expect(
      db.admin.execute(`update invoices set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        northstarInvoiceId,
      ]),
    ).rejects.toThrow(/organization_id is immutable/);
  });

  it("refuses re-pointing a line's organization_id or invoice_id", async () => {
    const rows = await observe(
      `select id from invoice_line_items where organization_id = ? and invoice_id = ? limit 1`,
      [world.northstar.organizationId, northstarInvoiceId],
    );
    const lineId = String(rows[0]?.['id']);

    await expect(
      db.admin.execute(`update invoice_line_items set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        lineId,
      ]),
    ).rejects.toThrow(/organization_id is immutable/);

    await expect(
      db.admin.execute(`update invoice_line_items set invoice_id = ? where id = ?`, [
        twinInvoiceId,
        lineId,
      ]),
    ).rejects.toThrow(/invoice_id is immutable/);
  });
});

describe('a credit belongs to one tenant only', () => {
  let northstarCreditId: string;

  it('is created, listed and summed within the acting tenant', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      credits.create(tx, northstar, {
        amount: 5_000,
        reason: 'Goodwill credit for the April outage',
        createdBy: world.northstar.owner.id,
      }),
    );
    northstarCreditId = created.id;
    expect(created.organizationId).toBe(world.northstar.organizationId);

    // A negative adjustment is also valid (the ledger is signed).
    await tenant.transaction(northstar, (tx) =>
      credits.create(tx, northstar, {
        amount: -1_500,
        reason: 'Correcting an over-credit',
        createdBy: world.northstar.owner.id,
      }),
    );

    const mine = await tenant.read(northstar, (tx) => credits.list(tx, northstar));
    expect(mine).toHaveLength(2);
    expect(mine.reduce((sum, row) => sum + row.amount, 0)).toBe(3_500);
  });

  it('is invisible to the twin, and its id resolves to null across the tenant line', async () => {
    const theirs = await tenant.read(twin, (tx) => credits.list(tx, twin));
    expect(theirs).toHaveLength(0);

    const crossed = await tenant.read(twin, (tx) => credits.findById(tx, twin, northstarCreditId));
    expect(crossed).toBeNull();

    const own = await tenant.read(northstar, (tx) =>
      credits.findById(tx, northstar, northstarCreditId),
    );
    expect(own?.id).toBe(northstarCreditId);
  });
});

describe('a discount belongs to one tenant only', () => {
  let northstarDiscountId: string;

  it('is created and listed within the acting tenant', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      discounts.create(tx, northstar, {
        label: 'Launch promo',
        kind: 'percent',
        amount: 15,
        expiresOn: null,
        createdBy: world.northstar.owner.id,
      }),
    );
    northstarDiscountId = created.id;
    expect(created.organizationId).toBe(world.northstar.organizationId);

    const mine = await tenant.read(northstar, (tx) => discounts.list(tx, northstar));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.kind).toBe('percent');
    expect(mine[0]?.amount).toBe(15);
  });

  it('is invisible to the twin and cannot be removed across the tenant line', async () => {
    const theirs = await tenant.read(twin, (tx) => discounts.list(tx, twin));
    expect(theirs).toHaveLength(0);

    const crossed = await tenant.read(twin, (tx) =>
      discounts.findById(tx, twin, northstarDiscountId),
    );
    expect(crossed).toBeNull();

    // The twin tries to delete Northstar's discount: the tenant-scoped predicate matches no row,
    // so nothing is removed and the record stands.
    await tenant.transaction(twin, (tx) => discounts.remove(tx, twin, northstarDiscountId));
    const stillThere = await tenant.read(northstar, (tx) =>
      discounts.findById(tx, northstar, northstarDiscountId),
    );
    expect(stillThere?.id).toBe(northstarDiscountId);

    // The owner removes it in its own tenant: now it is gone.
    await tenant.transaction(northstar, (tx) =>
      discounts.remove(tx, northstar, northstarDiscountId),
    );
    const gone = await tenant.read(northstar, (tx) =>
      discounts.findById(tx, northstar, northstarDiscountId),
    );
    expect(gone).toBeNull();
  });
});

describe('a usage-alert threshold round-trips and is one-per-metric', () => {
  it('creates, reads back and updates a rule within the tenant', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      usageAlerts.create(tx, northstar, {
        metric: 'seats',
        thresholdPercent: 80,
        active: true,
        createdBy: world.northstar.owner.id,
      }),
    );
    expect(created.metric).toBe('seats');
    expect(created.thresholdPercent).toBe(80);
    expect(created.active).toBe(true);

    const found = await tenant.read(northstar, (tx) =>
      usageAlerts.findById(tx, northstar, created.id),
    );
    expect(found?.thresholdPercent).toBe(80);

    const updated = await tenant.transaction(northstar, (tx) =>
      usageAlerts.update(tx, northstar, created.id, { thresholdPercent: 95, active: false }),
    );
    expect(updated.thresholdPercent).toBe(95);
    expect(updated.active).toBe(false);
    // Identity is untouched by the update.
    expect(updated.metric).toBe('seats');
    expect(updated.organizationId).toBe(world.northstar.organizationId);
  });

  it('refuses a second rule for the same metric in the same org', async () => {
    await expect(
      db.admin.execute(
        `insert into billing_usage_alerts
           (id, organization_id, metric, threshold_percent, active, created_by, created_at, updated_at)
         values (?, ?, 'seats', 50, 1, ?, utc_timestamp(3), utc_timestamp(3))`,
        [uuidv7(), world.northstar.organizationId, world.northstar.owner.id],
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it('refuses re-pointing a rule’s metric (0083 trigger)', async () => {
    const rows = await observe(
      `select id from billing_usage_alerts where organization_id = ? and metric = 'seats' limit 1`,
      [world.northstar.organizationId],
    );
    const ruleId = String(rows[0]?.['id']);
    await expect(
      db.admin.execute(`update billing_usage_alerts set metric = 'api' where id = ?`, [ruleId]),
    ).rejects.toThrow(/metric is immutable/);
  });

  it('lets the twin hold its own rule for the same metric', async () => {
    const theirs = await tenant.transaction(twin, (tx) =>
      usageAlerts.create(tx, twin, {
        metric: 'seats',
        thresholdPercent: 70,
        active: true,
        createdBy: world.twin.owner.id,
      }),
    );
    expect(theirs.organizationId).toBe(world.twin.organizationId);

    const mine = await tenant.read(northstar, (tx) => usageAlerts.list(tx, northstar));
    expect(mine).toHaveLength(1);
    expect(mine.map((row) => row.organizationId)).not.toContain(world.twin.organizationId);
  });
});
