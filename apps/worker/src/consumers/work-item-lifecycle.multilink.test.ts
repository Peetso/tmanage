import { describe, expect, it } from 'vitest';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { OutboxEffects } from '../outbox/dispatcher.js';
import { workItemLifecycleConsumer } from './work-item-lifecycle.js';

/**
 * R09: more than one request can be linked to the same work item.
 *
 * Acceptance permits linking existing work and the schema does not enforce one request per
 * linked item, so when that item moves, *every* request currently in the rule's `from` state
 * must follow. The old consumer read a single row with `LIMIT 1` and left the rest stale.
 *
 * The relay's real database proof is `apps/api/test/plat-004-relay.db.test.ts` (this change
 * adds the two-requests case there). Here we drive the consumer against an in-memory fake of
 * {@link WorkerTransaction} — the seam the store functions spell SQL through — so the loop
 * over every eligible linked request is pinned without a server.
 */

interface FakeRequest {
  readonly id: string;
  projectId: string;
  clientOrganizationId: string;
  state: string;
  version: number;
}

interface Recorder {
  readonly tx: WorkerTransaction;
  readonly requests: Map<string, FakeRequest>;
  readonly updates: { id: string; from: string; to: string }[];
  readonly audits: { objectId: string }[];
  readonly outbox: { aggregateId: string; payload: Record<string, unknown> }[];
}

function fakeTx(seed: readonly FakeRequest[]): Recorder {
  const requests = new Map<string, FakeRequest>(seed.map((r) => [r.id, { ...r }]));
  const updates: Recorder['updates'] = [];
  const audits: Recorder['audits'] = [];
  const outbox: Recorder['outbox'] = [];

  const tx: WorkerTransaction = {
    query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      await Promise.resolve();
      if (sql.includes('linked_work_item_id')) {
        // findRequestsLinkedToWorkItem — every linked row, ordered by id like the SQL.
        return [...requests.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((r) => ({
            id: r.id,
            project_id: r.projectId,
            client_organization_id: r.clientOrganizationId,
            state: r.state,
            version: r.version,
          })) as unknown as T;
      }
      if (sql.startsWith('UPDATE client_requests') || sql.includes('SET state =')) {
        // transitionLinkedRequest UPDATE: [to, organizationId, id, from]
        const [to, , id, from] = params as [string, string, string, string];
        const row = requests.get(id);
        if (row && row.state === from) {
          row.state = to;
          row.version += 1;
          updates.push({ id, from, to });
          return { affectedRows: 1 } as unknown as T;
        }
        return { affectedRows: 0 } as unknown as T;
      }
      if (sql.includes('version FROM client_requests')) {
        // transitionLinkedRequest read-back: [organizationId, id]
        const [, id] = params as [string, string];
        const row = requests.get(id);
        return (row ? [{ version: row.version }] : []) as unknown as T;
      }
      if (sql.includes('audit_events')) {
        // insertSystemAuditEvent: object_id is the 5th bound value.
        audits.push({ objectId: String((params as unknown[])[4]) });
        return {} as unknown as T;
      }
      if (sql.includes('outbox_events')) {
        // insertWorkerOutboxEvent: aggregate_id 5th, payload_json 6th.
        const p = params as unknown[];
        outbox.push({
          aggregateId: String(p[4]),
          payload: JSON.parse(String(p[5])) as Record<string, unknown>,
        });
        return {} as unknown as T;
      }
      throw new Error(`unexpected SQL in fake tx: ${sql}`);
    },
  };

  return { tx, requests, updates, audits, outbox };
}

const event = (workItemId: string, toState: string): ClaimedOutboxEvent => ({
  id: 'evt-0001',
  organizationId: 'org-1',
  type: 'work_item.updated.v1',
  schemaVersion: 1,
  aggregateType: 'work_item',
  aggregateId: workItemId,
  payload: { workItemId, toState },
  correlationId: 'corr-1',
  occurredAt: new Date(),
  attempts: 0,
});

// The lifecycle consumer registers no after-commit effect; a no-op satisfies the signature.
const noEffects: OutboxEffects = { afterCommit: () => {} };

const req = (id: string, state: string): FakeRequest => ({
  id,
  projectId: 'proj-1',
  clientOrganizationId: 'client-1',
  state,
  version: 3,
});

describe('the lifecycle consumer with a shared linked work item', () => {
  it('transitions every accepted request linked to the same started work item', async () => {
    const rec = fakeTx([req('req-a', 'accepted'), req('req-b', 'accepted')]);

    await workItemLifecycleConsumer(event('work-1', 'in_progress'), rec.tx, noEffects);

    expect(rec.requests.get('req-a')!.state).toBe('planned');
    expect(rec.requests.get('req-b')!.state).toBe('planned');
    expect(rec.updates.map((u) => u.id).sort()).toEqual(['req-a', 'req-b']);
    // One audit row and one transitioned event per request that actually moved.
    expect(rec.audits.map((a) => a.objectId).sort()).toEqual(['req-a', 'req-b']);
    expect(rec.outbox.map((o) => o.aggregateId).sort()).toEqual(['req-a', 'req-b']);
    for (const emitted of rec.outbox) {
      expect(emitted.payload).toMatchObject({
        fromStatus: 'accepted',
        toStatus: 'planned',
        acceptedWorkItemId: 'work-1',
        requestVersion: 4,
      });
    }
  });

  it('moves only the eligible requests, leaving replayed and unrelated ones untouched', async () => {
    // req-a is ours to move; req-b already advanced (replay/API-first); req-c is declined.
    const rec = fakeTx([
      req('req-a', 'accepted'),
      req('req-b', 'planned'),
      req('req-c', 'declined'),
    ]);

    await workItemLifecycleConsumer(event('work-1', 'in_progress'), rec.tx, noEffects);

    expect(rec.requests.get('req-a')!.state).toBe('planned');
    expect(rec.requests.get('req-b')!.state).toBe('planned'); // untouched, still v3
    expect(rec.requests.get('req-b')!.version).toBe(3);
    expect(rec.requests.get('req-c')!.state).toBe('declined');
    expect(rec.updates).toEqual([{ id: 'req-a', from: 'accepted', to: 'planned' }]);
    expect(rec.audits.map((a) => a.objectId)).toEqual(['req-a']);
    expect(rec.outbox.map((o) => o.aggregateId)).toEqual(['req-a']);
  });

  it('does nothing when no linked request is in the rule state (replay is success)', async () => {
    const rec = fakeTx([req('req-a', 'planned'), req('req-b', 'planned')]);

    await workItemLifecycleConsumer(event('work-1', 'in_progress'), rec.tx, noEffects);

    expect(rec.updates).toEqual([]);
    expect(rec.audits).toEqual([]);
    expect(rec.outbox).toEqual([]);
  });
});
