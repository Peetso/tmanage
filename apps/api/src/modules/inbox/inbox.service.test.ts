import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { NotificationRow, UsageCounterRow } from '../../common/database/schema.js';
import type { ClientRequestsService } from '../requests/client-requests.service.js';
import type { WorkItemsService } from '../work/work-items.service.js';
import type { UsageCountersRepository } from '../files/usage-counters.repository.js';
import { InboxService, type InboxUsageNoticeView } from './inbox.service.js';
import type { NotificationsRepository } from './notifications.repository.js';

/**
 * USAGE-001 slice 4b read side — the `organization_usage` resolver, the one behaviour the DB
 * suite (`inbox-001-inbox.db.test.ts`) does not cover because it needs a usage counter the inbox
 * did not write. Two facts, proven through the public `list`: an owner sees the notice resolved
 * to the organization's live counters, and a notice whose object is another tenant's
 * organization is never rendered (the tenant guard in `bundle`). Everything else about the inbox
 * — bundling, the silent drop of a revoked object, the forward-only mark — stays in the DB test.
 */

const CONTEXT = { organizationId: 'org-1' } as unknown as TenantContext;
const OWNER = { userId: 'owner-1', role: 'owner' } as unknown as Principal;
const MEMBER = { userId: 'member-9', role: 'member' } as unknown as Principal;

/** `read`/`transaction` that simply run the work against a throwaway runner — no server. */
const database = {
  async read<T>(_context: TenantContext, work: (runner: TenantQueryRunner) => Promise<T>) {
    return work({} as TenantQueryRunner);
  },
  async transaction<T>(_context: TenantContext, work: (runner: TenantQueryRunner) => Promise<T>) {
    return work({} as TenantQueryRunner);
  },
} as unknown as TenantDatabase;

function usageRow(objectId: string): NotificationRow {
  return {
    id: 'ntf-1',
    type: 'usage.threshold_reached.v1',
    objectType: 'organization_usage',
    objectId,
    readAt: null,
    createdAt: new Date('2026-09-19T08:00:00.000Z'),
  } as unknown as NotificationRow;
}

/** A canned notifications repository: one page, the rows it is handed. */
function notificationsReturning(rows: readonly NotificationRow[]): NotificationsRepository {
  return {
    async listForRecipient() {
      return rows;
    },
  } as unknown as NotificationsRepository;
}

/** A counter with 8.5 GiB held of the quota, sitting in the 85 band. */
function countersReturning(row: UsageCounterRow | null): UsageCountersRepository {
  return {
    async find() {
      return row;
    },
  } as unknown as UsageCountersRepository;
}

const COUNTER = {
  usedValue: 8_000_000_000,
  reservedValue: 500_000_000,
  thresholdBand: 85,
} as unknown as UsageCounterRow;

function serviceFor(
  rows: readonly NotificationRow[],
  counter: UsageCounterRow | null = COUNTER,
): InboxService {
  return new InboxService(
    database,
    {} as unknown as WorkItemsService,
    {} as unknown as ClientRequestsService,
    notificationsReturning(rows),
    { quotaBytes: 10_000_000_000, counters: countersReturning(counter) },
  );
}

describe('InboxService organization_usage resolver', () => {
  it('resolves the owner’s usage notice to band, used, reserved and quota', async () => {
    const page = await serviceFor([usageRow('org-1')]).list(CONTEXT, OWNER);

    expect(page.items).toHaveLength(1);
    const notice = page.items[0] as InboxUsageNoticeView;
    expect(notice.objectType).toBe('organization_usage');
    expect(notice.bundleId).toBe('organization_usage:org-1');
    expect(notice.objectId).toBe('org-1');
    expect(notice.band).toBe(85);
    expect(notice.used).toBe(8_000_000_000);
    expect(notice.reserved).toBe(500_000_000);
    expect(notice.quota).toBe(10_000_000_000);
    expect(notice.count).toBe(1);
    expect(notice.unreadCount).toBe(1);
  });

  it('drops a notice whose object is another tenant’s organization', async () => {
    const page = await serviceFor([usageRow('org-OTHER')]).list(CONTEXT, OWNER);
    expect(page.items).toHaveLength(0);
  });
});

/** A notifications repository whose `markRead` reports a fixed count of rows changed. */
function markingService(marked: number): InboxService {
  const notifications = {
    async markRead() {
      return marked;
    },
  } as unknown as NotificationsRepository;
  return new InboxService(
    database,
    {} as unknown as WorkItemsService,
    {} as unknown as ClientRequestsService,
    notifications,
    { quotaBytes: 10_000_000_000, counters: countersReturning(COUNTER) },
  );
}

describe('InboxService.markBundleRead organization_usage', () => {
  it('marks an owner’s own usage notice read', async () => {
    const result = await markingService(3).markBundleRead(
      CONTEXT,
      OWNER,
      'organization_usage:org-1',
    );
    expect(result).toEqual({ bundleId: 'organization_usage:org-1', marked: 3 });
  });

  it('refuses a same-org member who is not an owner/admin with 404 not_found', async () => {
    // The reauthorization the object branches give: not this person's notice, so the same 404.
    await expect(
      markingService(0).markBundleRead(CONTEXT, MEMBER, 'organization_usage:org-1'),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
