import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { HomeService } from '../src/modules/home/home.service.js';
import {
  MY_DAY_LIMIT,
  MY_DAY_STATES,
  MyDayRepository,
} from '../src/modules/home/my-day.repository.js';
import { WaitingRepository } from '../src/modules/home/waiting.repository.js';
import { SavedContextRepository } from '../src/modules/home/saved-context.repository.js';
import { SearchIndexRepository } from '../src/modules/search/search-index.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * H2 (L5 load-run misses) against a real MariaDB 11.8:
 *
 * 1. My Day is bounded at `MY_DAY_LIMIT`, in rank order, without `description`, while the hero's
 *    personal-work counts still cover every open owned item (one grouped SQL count).
 * 2. Search's work-item and message reads walk the 0234 recency keys newest-first — no filesort —
 *    and return the same rows as before (the substring predicate is unchanged).
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: HomeService;
let context: TenantContext;
let principal: Principal;

const HOUR = 60 * 60 * 1000;
const NOW = new Date();
const OVERDUE = 60;
const DUE_SOON = 20;
const UNDATED = 50;
const FILLER = 1_500;

async function insertItems(
  rows: readonly {
    title: string;
    state: string;
    ownerUserId: string | null;
    dueAt: Date | null;
    description?: string;
  }[],
): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = chunk
      .map(() => "(?, ?, ?, 'task', ?, ?, ?, ?, 'internal', ?, 1, utc_timestamp(3), ?)")
      .join(', ');
    const params = chunk.flatMap((row, index) => [
      uuidv7(),
      world.northstar.organizationId,
      world.northstar.projectId,
      row.title,
      row.description ?? null,
      row.state,
      row.ownerUserId,
      row.dueAt,
      new Date(NOW.getTime() - (start + index) * 1_000),
    ]);
    await db.admin.query(
      `insert into work_items
         (id, organization_id, project_id, type, title, description, state, owner_user_id,
          audience, due_at, version, created_at, updated_at)
       values ${values}`,
      params,
    );
  }
}

async function explain(sql: string, params: readonly unknown[]): Promise<RowDataPacket> {
  const [rows] = await db.admin.query<RowDataPacket[]>(`EXPLAIN ${sql}`, params as unknown[]);
  return rows[0] as RowDataPacket;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new HomeService(
    tenant,
    new MyDayRepository(),
    new WaitingRepository(),
    new SavedContextRepository(),
  );
  const owner = world.northstar.owner;
  context = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: owner.id,
    membershipId: owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-10-25',
    correlationId: uuidv7(),
  });
  principal = {
    userId: owner.id,
    organizationId: world.northstar.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: owner.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  await insertItems([
    ...Array.from({ length: OVERDUE }, (_, i) => ({
      title: `H2 overdue ${i}`,
      state: 'in_progress',
      ownerUserId: owner.id,
      dueAt: new Date(NOW.getTime() - (i + 1) * HOUR),
      description: 'a long description the card never shows',
    })),
    ...Array.from({ length: DUE_SOON }, (_, i) => ({
      title: `H2 due soon ${i}`,
      state: 'in_progress',
      ownerUserId: owner.id,
      dueAt: new Date(NOW.getTime() + (i + 1) * HOUR),
    })),
    ...Array.from({ length: UNDATED }, (_, i) => ({
      title: `H2 undated ${i}`,
      state: 'in_progress',
      ownerUserId: owner.id,
      dueAt: null,
    })),
    // Done work is never on My Day, however overdue its date.
    ...Array.from({ length: 10 }, (_, i) => ({
      title: `H2 done ${i}`,
      state: 'done',
      ownerUserId: owner.id,
      dueAt: new Date(NOW.getTime() - 1_000 * HOUR - i),
    })),
    ...Array.from({ length: FILLER }, (_, i) => ({
      title: `Filler ${i}`,
      state: 'in_progress',
      ownerUserId: null,
      dueAt: null,
    })),
  ]);
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

describe('My Day is bounded and the hero still counts everything (H2)', () => {
  it('returns at most MY_DAY_LIMIT rows in rank order, without description', async () => {
    const view = await service.myDayOf(context, principal, NOW);

    expect(view.items).toHaveLength(MY_DAY_LIMIT);
    const reasons = view.items.map((entry) => entry.reason);
    expect(reasons.slice(0, OVERDUE).every((reason) => reason === 'overdue')).toBe(true);
    expect(reasons.slice(OVERDUE, OVERDUE + DUE_SOON).every((r) => r === 'due_soon')).toBe(true);
    expect(reasons.slice(OVERDUE + DUE_SOON).every((r) => r === 'assigned')).toBe(true);
    expect(view.items[0]?.workItem.title).toBe(`H2 overdue ${OVERDUE - 1}`);
    expect(view.items.some((entry) => entry.workItem.title.startsWith('H2 done'))).toBe(false);
    expect(view.items.every((entry) => !('description' in entry.workItem))).toBe(true);
  });

  it('counts every open owned item, overdue and due soon exactly as the list ranks them', async () => {
    const summary = await service.summaryOf(context, principal, NOW);

    const [rows] = await db.admin.query<RowDataPacket[]>(
      `select count(*) as total,
              sum(due_at < ?) as overdue,
              sum(due_at >= ? and due_at <= ?) as due_soon
         from work_items
        where organization_id = ? and owner_user_id = ? and deleted_at is null
          and state in (?)`,
      [
        NOW,
        NOW,
        new Date(NOW.getTime() + 3 * 24 * HOUR),
        world.northstar.organizationId,
        world.northstar.owner.id,
        [...MY_DAY_STATES],
      ],
    );
    const expected = rows[0] as RowDataPacket;

    expect(summary.personalWork.total).toBe(Number(expected['total']));
    expect(summary.personalWork.overdue).toBe(Number(expected['overdue']));
    expect(summary.personalWork.dueSoon).toBe(Number(expected['due_soon']));
    expect(summary.personalWork.total).toBeGreaterThan(MY_DAY_LIMIT);
    expect(summary.personalWork.overdue).toBeGreaterThanOrEqual(OVERDUE);
  });
});

describe('search walks the recency keys (H2, 0234)', () => {
  it('the work-item search statement uses ix_work_items_org_updated without a filesort', async () => {
    const plan = await explain(
      `select project_id, id, title, audience, updated_at from work_items
        where organization_id = ? and deleted_at is null and title like ?
        order by updated_at desc, id asc limit 20`,
      [world.northstar.organizationId, '%Filler%'],
    );
    expect(String(plan['possible_keys'])).toContain('ix_work_items_org_updated');
    expect(plan['key']).toBe('ix_work_items_org_updated');
    expect(String(plan['Extra'] ?? '')).not.toContain('filesort');
  });

  it('the message search statement has ix_messages_org_updated available', async () => {
    const plan = await explain(
      `select id, conversation_id, body, updated_at from messages
        where organization_id = ? and deleted_at is null and body like ?
        order by updated_at desc, id asc limit 20`,
      [world.northstar.organizationId, '%x%'],
    );
    expect(String(plan['possible_keys'])).toContain('ix_messages_org_updated');
  });

  it('results are still the newest substring matches', async () => {
    const hits = await tenant.read(context, (runner) =>
      new SearchIndexRepository().searchRanked(runner, context, { query: 'iller 1', limit: 5 }),
    );
    expect(hits.map((hit) => hit.title)).toEqual([
      'Filler 1',
      'Filler 10',
      'Filler 11',
      'Filler 12',
      'Filler 13',
    ]);
  });
});
