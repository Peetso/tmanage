import { describe, expect, it } from 'vitest';
import { ACTIVITY_SOURCES, type ActivitySource } from '@tmanage/domain';
import {
  ACTIVITY_SETTLE_MS,
  projectEvent,
  runActivityProjection,
  type ActivityAuditEvent,
  type ActivityCursor,
  type ActivityEntryRecord,
  type ActivityPlacement,
  type ActivityProjectorStore,
} from './activity-projector.js';
import {
  ACTIVITY_PROJECTOR_SQL,
  PLACEMENT_SQL,
} from '../common/database/activity-projector-store.js';

/** 62-A2 (B02) — the projector files catalogued events once, in order, and resumes after a stop. */

const ORG = 'org-1';
const PROJECT = 'prj-1';
const CLIENT = 'cli-1';
const NOW = new Date('2026-11-19T12:00:00.000Z');

function event(
  n: number,
  action: string,
  extra: Partial<ActivityAuditEvent> = {},
): ActivityAuditEvent {
  return {
    id: `evt-${String(n).padStart(3, '0')}`,
    action,
    objectId: `obj-${String(n)}`,
    actorUserId: 'usr-1',
    result: 'allowed',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, n)),
    metadataProjectId: null,
    ...extra,
  };
}

/** An in-memory store with the table's two guarantees: unique `source_audit_id`, atomic batches. */
function fakeStore(
  events: readonly ActivityAuditEvent[],
  placements: Partial<Record<ActivitySource, ActivityPlacement | null>> = {},
) {
  const entries = new Map<string, ActivityEntryRecord>();
  const cursors = new Map<string, ActivityCursor | null>();
  const placed: { source: ActivitySource; key: string }[] = [];
  let failNextFile = false;
  const after = (e: ActivityAuditEvent, c: ActivityCursor | null) =>
    c === null ||
    e.createdAt > c.createdAt ||
    (e.createdAt.getTime() === c.createdAt.getTime() && e.id > c.eventId);
  const store: ActivityProjectorStore = {
    organizations: async () => [{ organizationId: ORG, cursor: cursors.get(ORG) ?? null }],
    eventsAfter: async (_org, cursor, settledBefore, limit) =>
      events.filter((e) => e.createdAt < settledBefore && after(e, cursor)).slice(0, limit),
    place: async (_org, source, e) => {
      placed.push({ source, key: e.objectId });
      return source in placements
        ? (placements[source] ?? null)
        : { projectId: PROJECT, clientOrganizationId: null, audience: 'internal' };
    },
    fileBatch: async (_org, batch, cursor) => {
      if (failNextFile) {
        failNextFile = false;
        throw new Error('connection lost');
      }
      let written = 0;
      for (const entry of batch) {
        if (entries.has(entry.sourceAuditId)) continue;
        entries.set(entry.sourceAuditId, entry);
        written += 1;
      }
      if (cursor !== null) cursors.set(ORG, cursor);
      return written;
    },
  };
  return { store, entries, cursors, placed, failNext: () => (failNextFile = true) };
}

describe('activity projector (62-A2)', () => {
  it('files catalogued, allowed events and skips the rest', async () => {
    const { store, entries } = fakeStore([
      event(1, 'work_item.created'),
      event(2, 'file_asset.downloaded'),
      event(3, 'approval.approved', { result: 'denied' }),
      event(4, 'client_invoice.sent'),
      event(5, 'work_item.transitioned', { objectId: null }),
    ]);
    const result = await runActivityProjection({ store, now: NOW });
    expect(result).toEqual({ organizations: 1, events: 5, filed: 2 });
    expect([...entries.keys()]).toEqual(['evt-001', 'evt-004']);
    expect(entries.get('evt-001')).toMatchObject({
      kind: 'work',
      objectType: 'work_item',
      audienceClass: 'internal',
      projectId: PROJECT,
    });
    expect(entries.get('evt-004')).toMatchObject({ kind: 'money', audienceClass: 'finance' });
  });

  it('is idempotent: the same audit id projected twice is one entry', async () => {
    const events = [event(1, 'work_item.created'), event(2, 'quote.sent')];
    const { store, entries, cursors } = fakeStore(events);
    await runActivityProjection({ store, now: NOW });
    cursors.clear(); // a lost cursor replays from the start
    const again = await runActivityProjection({ store, now: NOW });
    expect(again.filed).toBe(0);
    expect(entries.size).toBe(2);
  });

  it('is restart-safe: a failed batch moves no cursor, the next run files it', async () => {
    const events = [event(1, 'work_item.created'), event(2, 'work_item.updated')];
    const { store, entries, cursors, failNext } = fakeStore(events);
    failNext();
    await expect(runActivityProjection({ store, now: NOW })).rejects.toThrow('connection lost');
    expect(cursors.get(ORG)).toBeUndefined();
    expect(entries.size).toBe(0);
    const result = await runActivityProjection({ store, now: NOW });
    expect(result.filed).toBe(2);
    expect(cursors.get(ORG)).toEqual({ createdAt: events[1]!.createdAt, eventId: 'evt-002' });
  });

  it('is paced: one run reads at most its budget, the next continues after the cursor', async () => {
    const events = Array.from({ length: 7 }, (_, i) => event(i + 1, 'work_item.created'));
    const { store, entries } = fakeStore(events);
    expect((await runActivityProjection({ store, now: NOW, perRun: 3 })).events).toBe(3);
    expect((await runActivityProjection({ store, now: NOW, perRun: 3 })).events).toBe(3);
    expect((await runActivityProjection({ store, now: NOW, perRun: 3 })).events).toBe(1);
    expect(entries.size).toBe(7);
  });

  it('leaves events younger than the settle lag for a later run', async () => {
    const fresh = event(1, 'work_item.created', {
      createdAt: new Date(NOW.getTime() - ACTIVITY_SETTLE_MS + 1_000),
    });
    const { store, entries } = fakeStore([fresh]);
    expect((await runActivityProjection({ store, now: NOW })).events).toBe(0);
    expect(entries.size).toBe(0);
  });

  it('skips an object whose source row is gone, or that has neither project nor client', async () => {
    const { store, entries } = fakeStore(
      [event(1, 'work_item.created'), event(2, 'expense.created')],
      {
        work_item: null,
        expense: { projectId: null, clientOrganizationId: null, audience: 'internal' },
      },
    );
    expect((await runActivityProjection({ store, now: NOW })).filed).toBe(0);
    expect(entries.size).toBe(0);
  });

  it('files a client-only source under its client, with the client-visible class', async () => {
    const { store } = fakeStore([], {
      client_request: { projectId: null, clientOrganizationId: CLIENT, audience: 'client_visible' },
    });
    const entry = await projectEvent(store, ORG, event(1, 'client_request.submitted'));
    expect(entry).toMatchObject({
      clientOrganizationId: CLIENT,
      projectId: null,
      kind: 'requests',
      audienceClass: 'client_visible',
    });
  });

  it('resolves a membership through the project named in its audit row', async () => {
    const { store, placed } = fakeStore([]);
    await projectEvent(
      store,
      ORG,
      event(1, 'project_membership.revoked', { metadataProjectId: PROJECT }),
    );
    expect(placed).toEqual([{ source: 'project_membership', key: 'obj-1' }]);
  });
});

describe('activity projector statements (62-A2)', () => {
  it('has one tenant-scoped, two-parameter placement statement per catalogued source', () => {
    expect(Object.keys(PLACEMENT_SQL).sort()).toEqual([...ACTIVITY_SOURCES].sort());
    for (const source of ACTIVITY_SOURCES) {
      const sql = PLACEMENT_SQL[source];
      expect(sql, source).toMatch(/\.organization_id = \? AND \w+\.id = \?/);
      expect(sql.split('?').length - 1, source).toBe(2);
      expect(sql, source).toMatch(
        /AS project_id[\s\S]*AS client_organization_id[\s\S]*AS audience/,
      );
      expect(sql, source).not.toMatch(/title|name|body|feedback|amount/i);
    }
  });

  it('reads events by organization in (created_at, id) order and inserts entries with IGNORE', () => {
    expect(ACTIVITY_PROJECTOR_SQL.eventsAfter).toMatch(/e\.organization_id = \?/);
    expect(ACTIVITY_PROJECTOR_SQL.eventsAfter).toMatch(/ORDER BY e\.created_at, e\.id/);
    expect(ACTIVITY_PROJECTOR_SQL.eventsFromStart).toMatch(/ORDER BY e\.created_at, e\.id/);
    expect(ACTIVITY_PROJECTOR_SQL.insertEntry).toMatch(/^INSERT IGNORE INTO activity_entries/);
  });
});
