import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { allows, parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ClientInvoicesRepository } from '../src/modules/finance/client-invoices.repository.js';
import { ClientInvoicesService } from '../src/modules/finance/client-invoices.service.js';
import { DocumentSequenceService } from '../src/modules/finance/document-sequences.js';
import { FinanceRepository } from '../src/modules/finance/finance.repository.js';
import { NotificationsRepository } from '../src/modules/inbox/notifications.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * 52-09 (0301) at the engine. Registry: the six tables are registered and granted as the brief
 * says. INT-52-19: send is one transaction (number, snapshots, hash) and retry-safe on its key.
 * INT-52-20: a sent invoice and its lines refuse an UPDATE at the trigger. INT-52-21: twenty
 * concurrent sends take twenty gapless numbers. CONC-52-02: two senders on one draft — one 409.
 * AUTH-52-10: another client of the same studio reads a 404.
 */

let db: TestDatabase;
let world: SeedWorld;
let service: ClientInvoicesService;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);
const SIX = [
  'client_invoices',
  'client_invoice_lines',
  'client_invoice_payments',
  'client_credit_notes',
  'client_credit_note_lines',
  'client_invoice_events',
];

beforeAll(async () => {
  db = await startTestDatabase();
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  const finance = new FinanceRepository();
  service = new ClientInvoicesService({
    database: tenant,
    repository: new ClientInvoicesRepository(),
    finance,
    sequences: new DocumentSequenceService(finance),
    notifications: new NotificationsRepository(),
    audit: new AuditService(tenant, new AuditEventsRepository()),
  });
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db.stop();
});

function owner(): { context: TenantContext; principal: Principal } {
  const ns = world.northstar;
  return {
    context: createTenantContext({
      organizationId: ns.organizationId,
      userId: ns.owner.id,
      membershipId: ns.owner.membershipId,
      principalKind: 'internal',
      capabilities: capabilitiesFor('owner'),
      policyVersion: '2026-11-02',
      correlationId: uuidv7(),
    }),
    principal: {
      userId: ns.owner.id,
      organizationId: ns.organizationId,
      kind: 'internal',
      role: 'owner',
      membershipId: ns.owner.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    } as Principal,
  };
}

/** A draft for Atlas with one manual line of 1,000.00 + 15 % tax. */
async function draft(): Promise<string> {
  const { context, principal } = owner();
  const created = await service.create(context, principal, {
    clientOrganizationId: world.atlas.clientOrganizationId,
    currency: 'SAR',
    language: 'bi',
  });
  await service.update(context, principal, created.id, {
    expectedVersion: created.version,
    lines: [{ descriptionEn: 'Brand workshop', quantity: 1, unitPriceMinor: 100_000, taxBp: 1500 }],
  });
  return created.id;
}

async function send(id: string, key: string) {
  const { context, principal } = owner();
  return service.send(
    context,
    principal,
    id,
    { to: ['ap@atlas.example'] },
    { orgSlug: 'northstar', idempotencyKey: key },
  );
}

describe('0301 — registry', () => {
  it('registers the six tables and grants the app, never the worker', () => {
    const app = intents.get("'tmanage_app'@'%'") as NonNullable<ReturnType<typeof intents.get>>;
    const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    for (const table of SIX) {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
      expect(allows(app, `tmanage.${table}:INSERT`)).toBe(true);
      expect(allows(worker, `tmanage.${table}:INSERT`)).toBe(false);
    }
    expect(allows(app, 'tmanage.client_invoice_lines:DELETE')).toBe(true);
    expect(allows(app, 'tmanage.client_invoice_payments:UPDATE')).toBe(false);
  });
});

describe('INT-52-19 / INT-52-20 — send and the frozen invoice', () => {
  it('numbers, snapshots and hashes in one send; a retry with the key answers the same', async () => {
    const id = await draft();
    const first = await send(id, 'key-1');
    expect(first.number).toMatch(/^INV-\d{4}-0001$/u);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.totalMinor).toBe(115_000);
    expect(await send(id, 'key-1')).toEqual(first);
  });

  it('refuses an UPDATE of a sent invoice and of its lines at the trigger', async () => {
    const id = await draft();
    await send(id, 'key-2');
    await expect(
      db.admin.query('UPDATE client_invoices SET total_minor = 1 WHERE id = ?', [id]),
    ).rejects.toThrow(/sent/u);
    await expect(
      db.admin.query('UPDATE client_invoice_lines SET quantity_centi = 1 WHERE invoice_id = ?', [
        id,
      ]),
    ).rejects.toThrow(/sent/u);
  });
});

describe('INT-52-21 / CONC-52-02 — numbering and racing senders', () => {
  it('gives twenty concurrent sends twenty gapless numbers', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) ids.push(await draft());
    const sent = await Promise.all(ids.map((id, i) => send(id, `bulk-${String(i)}`)));
    const counters = sent.map((v) => Number(v.number?.slice(-4))).sort((a, b) => a - b);
    expect(counters).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('lets one of two senders win and answers the other 409', async () => {
    const id = await draft();
    const results = await Promise.allSettled([send(id, 'a'), send(id, 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
  });
});

describe('AUTH-52-10 — the portal projection across clients', () => {
  it('is a 404 for another client of the same studio', async () => {
    const id = await draft();
    await send(id, 'key-3');
    const meridian: Principal = {
      userId: world.meridian.reviewer.id,
      organizationId: world.northstar.organizationId,
      kind: 'client',
      role: 'client_admin',
      membershipId: world.meridian.reviewer.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: world.meridian.clientOrganizationId,
      projectIds: [world.meridian.projectId],
      hasOrgWideScope: false,
    };
    const context = createTenantContext({
      organizationId: world.northstar.organizationId,
      userId: meridian.userId,
      membershipId: meridian.membershipId,
      principalKind: 'client',
      capabilities: capabilitiesFor('client_admin'),
      policyVersion: '2026-11-02',
      correlationId: uuidv7(),
    });
    await expect(service.portalGet(context, meridian, id)).rejects.toMatchObject({ status: 404 });
  });
});
