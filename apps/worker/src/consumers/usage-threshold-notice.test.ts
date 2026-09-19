import { describe, expect, it } from 'vitest';
import { INTERNAL_ROLES } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects } from '../outbox/dispatcher.js';
import {
  isUsageThresholdRecipient,
  usageThresholdReachedConsumer,
} from './usage-threshold-notice.js';

/**
 * The unit half of USAGE-001 slice 4b. The recipient rule is pure and enumerated here; the
 * fan-out and the replay dedupe are driven through a fake transaction that answers the
 * membership read and records the notification inserts, exactly the two statements the consumer
 * issues. No DB test is needed: the consumer reads one table and writes one, and the fake proves
 * both without a server.
 */

interface Membership {
  readonly user_id: string;
  readonly role: string;
  readonly has_org_wide_scope: number;
}

interface Insert {
  readonly recipient: string;
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly dedupeKey: string;
}

/** A transaction stand-in: canned memberships, recorded inserts, uq dedupe simulated. */
function fakeTx(memberships: readonly Membership[]): {
  readonly tx: WorkerTransaction;
  readonly inserts: Insert[];
} {
  const inserts: Insert[] = [];
  const seen = new Set<string>();
  const tx = {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      if (/FROM memberships/.test(sql)) return memberships;
      if (/INSERT INTO notifications/.test(sql)) {
        // The insert binds these seven params in order; a tuple keeps each a `string` under
        // noUncheckedIndexedAccess rather than the `string | undefined` an array index yields.
        const [, org, recipient, type, objectType, objectId, dedupeKey] = params as readonly [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        const key = `${org}|${recipient}|${dedupeKey}`;
        if (seen.has(key)) return { affectedRows: 0 };
        seen.add(key);
        inserts.push({ recipient, type, objectType, objectId, dedupeKey });
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as unknown as WorkerTransaction;
  return { tx, inserts };
}

function event(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    id: 'evt-1',
    organizationId: 'org-1',
    type: 'usage.threshold_reached.v1',
    schemaVersion: 1,
    aggregateType: 'usage_counter',
    aggregateId: 'counter-1',
    payload: { organizationId: 'org-1', band: 85, idempotencyKey: 'counter-1:85:7' },
    correlationId: null,
    occurredAt: new Date(),
    attempts: 1,
    ...overrides,
  };
}

describe('isUsageThresholdRecipient', () => {
  it('tells org-wide owner and org_admin, and no other internal role', () => {
    const billing = new Set(['owner', 'org_admin']);
    for (const role of INTERNAL_ROLES) {
      expect(isUsageThresholdRecipient({ userId: 'u', role, hasOrgWideScope: true }), role).toBe(
        billing.has(role),
      );
    }
  });
});

/** The consumer is an `OutboxHandler` (event, tx, effects); it stages no after-commit work, so a
 * no-op effects collector satisfies the signature without affecting behaviour. */
const noEffects: OutboxEffects = { afterCommit: () => {} };

describe('usageThresholdReachedConsumer', () => {
  const memberships: readonly Membership[] = [
    { user_id: 'owner-1', role: 'owner', has_org_wide_scope: 1 },
    { user_id: 'admin-1', role: 'org_admin', has_org_wide_scope: 1 },
    { user_id: 'member-1', role: 'member', has_org_wide_scope: 1 },
    { user_id: 'owner-scoped', role: 'owner', has_org_wide_scope: 0 },
  ];

  it('fans out to org-wide owner and admin only, member excluded', async () => {
    const { tx, inserts } = fakeTx(memberships);
    await usageThresholdReachedConsumer(event(), tx, noEffects);
    expect(inserts.map((i) => i.recipient).sort()).toEqual(['admin-1', 'owner-1']);
    for (const insert of inserts) {
      expect(insert.type).toBe('usage.threshold_reached.v1');
      expect(insert.objectType).toBe('organization_usage');
      expect(insert.objectId).toBe('org-1');
      expect(insert.dedupeKey).toBe('usage.threshold_reached:counter-1:85:7');
    }
  });

  it('is idempotent on redelivery: the same crossing writes each recipient once', async () => {
    const { tx, inserts } = fakeTx(memberships);
    await usageThresholdReachedConsumer(event(), tx, noEffects);
    await usageThresholdReachedConsumer(event(), tx, noEffects); // outbox may deliver twice
    expect(inserts.map((i) => i.recipient).sort()).toEqual(['admin-1', 'owner-1']);
  });
});
