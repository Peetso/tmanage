import { createPool } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';

/**
 * E2E billing journey fixture (e2e-billing, wave 2). The seed world carries no `invoices` row and
 * the running stack mints none — invoice generation is the subscription lifecycle / a payment
 * provider (Needs-Peter), and the billing invoice slice (x179) is read-only — so the "invoice" leg
 * of the subscription -> seat -> invoice journey has nothing to list or open against until this CLI
 * seeds one. Spawned from the e2e spec the way `seed-cli`/`approval-fixture-cli` are, through this
 * package's own database client, because the e2e package deliberately holds none.
 *
 * It inserts exactly one tenant-scoped `invoices` row — a `paid` invoice with a two-line breakdown
 * carried in the `line_items` JSON column (the column the detail read projects; there is no child
 * table on that path). The header total equals the sum of the line totals, as a real invoice's does.
 * Dates are bound `Date` values, never the connection's `now(3)` (the admin-pool clock trap): an
 * e2e assertion that pins the issued month must not drift with the test machine's wall clock.
 *
 * The write goes through the admin/migration connection (the same one the seed uses), deliberately
 * outside the tenant guard: a fixture is infrastructure, not a request, and there is no HTTP route
 * that would create this row. The id and number are unique per run (`uuidv7`), so re-running the
 * harness never collides on `uq_invoices_org_number`.
 *
 * Usage: `tsx test/billing-invoice-fixture-cli.ts <organizationId>` with
 * `TMANAGE_SEED_DATABASE_URL` set. Positional arg (not a JSON blob) because the e2e harness spawns
 * through a shell on Windows and a UUID carries nothing a shell would re-interpret. stdout is the
 * contract: exactly one JSON line. Test tooling only; no runtime path invokes it.
 */

interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly amountCents: number;
}

const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const [organizationId] = process.argv.slice(2);
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (!organizationId) {
  console.error('usage: billing-invoice-fixture-cli <organizationId>');
  process.exit(1);
}

const lineItems: readonly InvoiceLine[] = [
  { description: 'Pro plan — monthly', quantity: 1, unitAmountCents: 4900, amountCents: 4900 },
  { description: 'Additional seats', quantity: 3, unitAmountCents: 1500, amountCents: 4500 },
];
const amountCents = lineItems.reduce((sum, line) => sum + line.amountCents, 0);

const id = uuidv7();
// Unique per run so re-seeding the harness never collides on `uq_invoices_org_number`.
const number = `E2E-${id.slice(0, 8).toUpperCase()}`;
const currency = 'USD';
const status = 'paid';
// A fixed, bound period and issued time — never `now(3)`, so an assertion on the invoice does not
// drift with the test machine's clock.
const periodStart = new Date('2026-09-01T00:00:00.000Z');
const periodEnd = new Date('2026-09-30T23:59:59.000Z');
const issuedAt = new Date('2026-10-01T09:00:00.000Z');
const createdAt = issuedAt;

const pool = createPool({ uri: url, connectionLimit: 1, timezone: 'Z' });
try {
  await pool.execute(
    `insert into invoices
       (id, organization_id, number, period_start, period_end, amount_cents, currency, status,
        line_items, issued_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      organizationId,
      number,
      periodStart,
      periodEnd,
      amountCents,
      currency,
      status,
      JSON.stringify(lineItems),
      issuedAt,
      createdAt,
    ],
  );
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(
    `${JSON.stringify({
      invoiceId: id,
      number,
      amountCents,
      currency,
      status,
      lineItemCount: lineItems.length,
    })}\n`,
  );
} finally {
  await pool.end();
}
