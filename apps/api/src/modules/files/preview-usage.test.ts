import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { FilePreviewsRepository } from './file-previews.repository.js';
import { PreviewUsageMeter } from './preview-usage.js';
import type { UsageCountersRepository } from './usage-counters.repository.js';
import type {
  RecordUsageLedgerEntryInput,
  UsageLedgerRepository,
} from './usage-ledger.repository.js';

/** R4 follow-up — the meter's rules against an in-memory counter, ledger and outbox. */
function harness(used = 0) {
  const state = { used, events: [] as string[], ledger: new Map<string, number>() };
  const counters = {
    ensure: async () => undefined,
    addUsed: async (_t: unknown, _c: unknown, _m: string, bytes: number) => {
      state.used += bytes;
      return true;
    },
    releaseUsed: async (_t: unknown, _c: unknown, _m: string, bytes: number) => {
      if (state.used < bytes) return false;
      state.used -= bytes;
      return true;
    },
  } as unknown as UsageCountersRepository;
  const ledger = {
    hasEntry: async (_t: unknown, _c: unknown, id: string, reason: string) =>
      state.ledger.has(`${id}:${reason}`),
    record: async (_t: unknown, _c: unknown, input: RecordUsageLedgerEntryInput) => {
      state.ledger.set(`${input.uploadSessionId}:${input.reason}`, input.deltaBytes);
    },
  } as unknown as UsageLedgerRepository;
  const outbox = {
    append: async (_t: unknown, _c: unknown, input: { type: string }) => {
      state.events.push(input.type);
      return uuidv7();
    },
  } as unknown as OutboxEventsRepository;
  return { state, meter: new PreviewUsageMeter(counters, ledger, outbox) };
}

const tx = {} as TenantQueryRunner;
const context = createServiceContext({
  organizationId: uuidv7(),
  correlationId: uuidv7(),
  policyVersion: 'test',
});
const preview = (sizeBytes: number) => ({
  id: uuidv7(),
  fileAssetId: uuidv7(),
  fileVersionId: uuidv7(),
  kind: 'thumb' as const,
  sizeBytes,
});

describe('PreviewUsageMeter', () => {
  it('counts a derivative once, with its event and ledger row, and gives it back once', async () => {
    const t = harness();
    const row = preview(2048);
    expect(await t.meter.count(tx, context, row)).toBe(true);
    expect(await t.meter.count(tx, context, row)).toBe(false);
    expect(t.state.used).toBe(2048);
    expect(t.state.events).toEqual(['file.preview_ready.v1']);
    expect(await t.meter.release(tx, context, row)).toBe('released');
    expect(await t.meter.release(tx, context, row)).toBe('not_counted');
    expect(t.state.used).toBe(0);
    expect([...t.state.ledger.values()]).toEqual([2048, -2048]);
  });

  it('never subtracts a derivative that was not counted (made before counting existed)', async () => {
    const t = harness(5000);
    expect(await t.meter.release(tx, context, preview(1000))).toBe('not_counted');
    expect(t.state.used).toBe(5000);
    expect(t.state.events).toEqual([]);
  });

  it('backfills the uncounted ready derivatives the repository lists', async () => {
    const t = harness();
    const previews = {
      listUncounted: async () => [preview(10), preview(20)],
    } as unknown as FilePreviewsRepository;
    expect(await t.meter.backfill(tx, context, previews)).toBe(2);
    expect(t.state.used).toBe(30);
  });
});
