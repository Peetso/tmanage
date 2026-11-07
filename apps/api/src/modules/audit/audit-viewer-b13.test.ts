import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AuditService, NO_SCANNER_SUMMARY, toAdminAuditView } from './audit.service.js';
import type { AuditEventsRepository } from './audit-events.repository.js';
import type { AuditEventChangesRepository } from './audit-event-changes.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** B13 (2026-11-02 live test): the detail aside's before/after read, and the no-scanner row. */
const context = { organizationId: 'org-1' } as unknown as TenantContext;
const event = { id: 'ev-1', organizationId: 'org-1', actorUserId: 'actor-1' };
const database = {
  read: async (_ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;
const events = {
  findById: async (_r: unknown, _c: unknown, id: string) => (id === event.id ? event : null),
} as unknown as AuditEventsRepository;
const changes = {
  listFor: async () => [
    { field: 'title', beforeValue: 'Old', afterValue: 'New', redacted: false },
    { field: 'apiSecret', beforeValue: 'x', afterValue: 'y', redacted: true },
  ],
} as unknown as AuditEventChangesRepository;
const service = new AuditService(database, events, changes);
const who = (userId: string, hasOrgWideScope: boolean) =>
  ({ userId, role: 'owner', hasOrgWideScope }) as unknown as Principal;

describe('AuditService.changesForViewer', () => {
  it('returns before/after, never a redacted value, and 404s outside the caller scope', async () => {
    await expect(service.changesForViewer(context, who('other', true), 'ev-1')).resolves.toEqual([
      { field: 'title', before: 'Old', after: 'New', redacted: false },
      { field: 'apiSecret', before: null, after: null, redacted: true },
    ]);
    await expect(
      service.changesForViewer(context, who('other', false), 'ev-1'),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.changesForViewer(context, who('actor-1', false), 'nope'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('toAdminAuditView', () => {
  it('reads the none-driver row as "not virus-scanned", not as a failure', () => {
    const base = {
      id: 'ev-2',
      action: 'file_asset.scan_failed',
      objectType: 'file_asset',
      objectId: 'f-1',
      result: 'error' as const,
      actorUserId: null,
      effectiveActorId: null,
      correlationId: 'c',
      createdAt: '2026-11-02T10:00:00.000Z',
    };
    const view = toAdminAuditView({ ...base, metadata: { cause: 'no_scanner' } });
    expect(view).toMatchObject({ summary: NO_SCANNER_SUMMARY, scanNote: 'no_scanner' });
    expect(toAdminAuditView({ ...base, metadata: { cause: 'store_error' } }).scanNote).toBe(
      undefined,
    );
  });
});
