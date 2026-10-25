import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { assertSafeAuditMetadata } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditEventRow, UsageCounterRow } from '../../common/database/schema.js';
import { UsageExportController } from '../billing/usage-export.controller.js';
import type { UsageExportRepository } from '../billing/usage-export.repository.js';
import { UsageExportService } from '../billing/usage-export.service.js';
import { AuditController } from './audit.controller.js';
import { AuditExportController } from './audit-export.controller.js';
import type { AppendAuditEventInput, AuditEventsRepository } from './audit-events.repository.js';
import { AuditService } from './audit.service.js';

/**
 * Wave 9 S8 — audit F53: exporting the audit trail (both routes) and the usage CSV wrote no audit
 * record. Over the real `AuditService` with a fake events repository that applies the real
 * metadata rule: each successful export appends exactly one `allowed` row naming the actor, the
 * CSV is still returned, and an export whose row cannot be written hands out nothing (fails closed).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = '00000000-0000-4000-8000-0000000000c9';

const context = { organizationId: ORG, correlationId: 'c-f53' } as unknown as TenantContext;

const admin: Principal = {
  userId: ADMIN,
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: '00000000-0000-4000-8000-0000000000e9',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

const trail: AuditEventRow[] = [
  {
    id: '0199aa00-0000-7000-8000-000000000001',
    organizationId: ORG,
    actorUserId: ADMIN,
    effectiveActorId: null,
    action: 'project.created',
    objectType: 'project',
    objectId: null,
    result: 'allowed',
    correlationId: 'c-1',
    metadataJson: {},
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
  } as unknown as AuditEventRow,
];

function harness(options: { failWrite?: boolean } = {}) {
  const appended: AppendAuditEventInput[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const events = {
    list: async (_r: unknown, _c: unknown, opts: { before?: string } = {}) =>
      opts.before ? [] : trail,
    append: async (_r: unknown, _c: unknown, input: AppendAuditEventInput) => {
      if (options.failWrite) throw new Error('database unavailable');
      assertSafeAuditMetadata(input.metadata);
      appended.push(input);
      return input;
    },
  } as unknown as AuditEventsRepository;
  const audit = new AuditService(database, events);
  const counters = {
    listForExport: async () =>
      [
        {
          id: 'u-1',
          organizationId: ORG,
          metricKey: 'storage.bytes',
          usedValue: 1,
          reservedValue: 0,
          version: 1,
          reconciledAt: null,
          thresholdBand: 0,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date('2026-03-02T00:00:00.000Z'),
        },
      ] as unknown as UsageCounterRow[],
  } as unknown as UsageExportRepository;
  return {
    appended,
    trailExport: new AuditController(audit),
    windowExport: new AuditExportController(audit),
    usageExport: new UsageExportController(new UsageExportService(database, counters), audit),
  };
}

const reply = { header: () => undefined };
const WINDOW = ['2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'] as const;

describe('wave9-S8 F53: every export leaves exactly one audit row naming the actor', () => {
  it('GET audit/events/export', async () => {
    const h = harness();
    const file = await h.trailExport.export(context, admin, reply, undefined, ADMIN);
    expect(file).toBeDefined();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      action: 'audit.exported',
      result: 'allowed',
      actorUserId: ADMIN,
      metadata: { export_kind: 'audit_events', row_count: 1, filter_actor: true },
    });
  });

  it('GET audit/export.csv (windowed)', async () => {
    const h = harness();
    await h.windowExport.export(
      context,
      admin,
      reply,
      WINDOW[0],
      WINDOW[1],
      undefined,
      'free text',
    );
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      action: 'audit.exported',
      actorUserId: ADMIN,
      metadata: { export_kind: 'audit_window', window_from: WINDOW[0], filter_action: 'other' },
    });
  });

  it('GET billing/usage/export.csv', async () => {
    const h = harness();
    await h.usageExport.export(context, admin, reply, WINDOW[0], WINDOW[1]);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      action: 'usage.exported',
      actorUserId: ADMIN,
      metadata: { export_kind: 'usage_counters', row_count: 1 },
    });
  });

  it('fails closed: when the audit row cannot be written, no CSV is handed out', async () => {
    const h = harness({ failWrite: true });
    await expect(h.trailExport.export(context, admin, reply)).rejects.toThrow();
    await expect(h.windowExport.export(context, admin, reply, ...WINDOW)).rejects.toThrow();
    await expect(h.usageExport.export(context, admin, reply, ...WINDOW)).rejects.toThrow();
  });
});
