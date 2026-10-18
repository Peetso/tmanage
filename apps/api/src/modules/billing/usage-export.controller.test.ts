import { describe, expect, it } from 'vitest';
import type { Readable } from 'node:stream';
import type { Principal } from '@tmanage/domain';
import { UsageExportController } from './usage-export.controller.js';
import { UsageExportService, USAGE_EXPORT_MAX_ROWS } from './usage-export.service.js';
import type { UsageExportRepository } from './usage-export.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { UsageCounterRow } from '../../common/database/schema.js';

/**
 * Billing usage export (x227). `UsageExportController.export` — the date-windowed usage CSV over
 * `GET .../billing/usage/export.csv`, behind `org.manage`.
 *
 * Database-free proofs with the *real* {@link UsageExportService}: the capability decision, the tenant
 * scope and the row cap are the service's real code over a fake repository, so this covers the slice's
 * own security logic — the window validation (400), the in-memory window filter, the CSV
 * formula-injection guard, the 413 row cap, and the 403 for a role without `org.manage`. The migration
 * and the tenant-scoped SQL round-trip are the chain's DB suite, not here.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function row(overrides: Partial<UsageCounterRow>): UsageCounterRow {
  return {
    id: 'usage-0000-0000-0000-0000-000000000000',
    organizationId: ORG,
    metricKey: 'storage.bytes',
    usedValue: 10,
    reservedValue: 0,
    version: 1,
    reconciledAt: null,
    thresholdBand: 70,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-10T00:00:00.000Z'),
    ...overrides,
  } as unknown as UsageCounterRow;
}

/** A controller on the real service over a fake repository holding exactly `store`. */
function controllerWith(store: readonly UsageCounterRow[]): UsageExportController {
  const database = {
    read: async (_ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const counters = {
    listForExport: async (_runner: unknown, ctx: TenantContext, limit: number) =>
      store.filter((r) => r.organizationId === ctx.organizationId).slice(0, limit),
  } as unknown as UsageExportRepository;
  return new UsageExportController(new UsageExportService(database, counters));
}

function reply(): { header(name: string, value: string): unknown; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return { headers, header: (name, value) => headers.set(name.toLowerCase(), value) };
}

async function drain(file: { getStream(): Readable }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

const WINDOW = { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' };

describe('UsageExportController.export', () => {
  it('exports tenant rows inside the window, dropping a cross-tenant and an out-of-window row', async () => {
    const controller = controllerWith([
      row({ id: 'u1', metricKey: 'seats.active', updatedAt: new Date('2026-03-10T00:00:00.000Z') }),
      row({ id: 'u2', metricKey: 'api.requests', updatedAt: new Date('2026-09-01T00:00:00.000Z') }),
      row({ id: 'u3', organizationId: OTHER_ORG, metricKey: 'storage.bytes' }),
    ]);
    const res = reply();
    const csv = await drain(
      await controller.export(context, principal('owner'), res, WINDOW.from, WINDOW.to),
    );
    expect(csv).toContain('seats.active'); // in window
    expect(csv).not.toContain('api.requests'); // out of window
    expect(csv.split('\r\n').filter((l) => l.includes('storage.bytes'))).toHaveLength(0); // other tenant
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('neutralises a usage cell that begins with a formula trigger', async () => {
    const controller = controllerWith([row({ id: 'u1', metricKey: '=cmd,1' })]);
    const csv = await drain(
      await controller.export(context, principal('owner'), reply(), WINDOW.from, WINDOW.to),
    );
    // The guard prefixes a single quote; the comma then forces RFC-4180 quoting: `"'=cmd,1"`.
    expect(csv).toContain(`"'=cmd,1"`);
    expect(csv).not.toContain(',=cmd,'); // never an unescaped leading '='
  });

  it('refuses an inverted window with a 400 and never reads', async () => {
    const controller = controllerWith([]);
    await expect(
      controller.export(context, principal('owner'), reply(), WINDOW.to, WINDOW.from),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an over-wide window with a 400', async () => {
    const controller = controllerWith([]);
    await expect(
      controller.export(
        context,
        principal('owner'),
        reply(),
        '2025-01-01T00:00:00.000Z',
        '2026-12-31T00:00:00.000Z',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses past the row cap with a 413', async () => {
    const overflow = Array.from({ length: USAGE_EXPORT_MAX_ROWS + 1 }, (_unused, index) =>
      row({ id: `u${index}`, metricKey: `metric.${index}` }),
    );
    const controller = controllerWith(overflow);
    await expect(
      controller.export(context, principal('owner'), reply(), WINDOW.from, WINDOW.to),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('refuses a role without org.manage with a 403', async () => {
    const controller = controllerWith([]);
    await expect(
      controller.export(context, principal('workspace_admin'), reply(), WINDOW.from, WINDOW.to),
    ).rejects.toMatchObject({ status: 403 });
  });
});
