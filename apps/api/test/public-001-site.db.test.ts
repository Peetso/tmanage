import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { IdentityScopeViolation, TenantDatabase } from '../src/common/database/tenant-context.js';
import { StatusRepository } from '../src/modules/public-site/status.repository.js';
import { ChangelogRepository } from '../src/modules/public-site/changelog.repository.js';
import { MarketingLeadsRepository } from '../src/modules/public-site/contact.repository.js';
import { MAX_INCIDENTS, toPublicStatus } from '../src/modules/public-site/status.controller.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * PUBLIC-001 against a real server — the Public & trust site module's three storage tables
 * (0060 `incidents`, 0061 `changelog_entries`, 0062 `marketing_leads`).
 *
 * All three are deliberately GLOBAL (org-less): they are read or written before any organization is
 * named, so they carry no `organization_id`, are registered in `NON_TENANT_TABLES`, and are reached
 * only through `TenantDatabase.identityRead` / `identityTransaction`. That shape is the whole of this
 * module's isolation story, and it is what this suite proves end-to-end against real InnoDB rather
 * than through the DB-free controller fakes:
 *
 * 1. **Published-only is the engine's gate, not the controller's.** A draft incident / changelog
 *    entry is never returned by the repository read — the `WHERE published = 1` (and, for the
 *    changelog, `published_at IS NOT NULL`) predicate holds in the SQL, so a draft can never reach a
 *    projection even if a caller bypassed the controller. The round-tripped row then survives the
 *    public projection without leaking the `published` flag or a draft's contents.
 * 2. **Ordering and the page bound are deterministic.** Incidents come back newest-first by
 *    `started_at`; changelog entries newest-first by `published_at` with `id` breaking ties, so two
 *    entries published in the same instant have one stable order. Both reads honour their limit.
 * 3. **A lead persists exactly what was submitted, attributed to its source, and nothing more** —
 *    the write-only door records the lead and never hands anything back.
 * 4. **No public read or write can be scoped to, or reach, a tenant's data.** The identity path
 *    these tables ride refuses a statement that strays to a tenant table, and refuses a unit of work
 *    that even declares one — the org-less equivalent of cross-tenant isolation.
 *
 * Conventions follow `work-003-blockers-dependencies.db.test.ts`. The admin pool clock is SYSTEM, so
 * every row is dated from a bound `new Date(...)` here, never `current_timestamp`, keeping the
 * ordering assertions independent of the machine clock.
 */

let db: TestDatabase;
let tenant: TenantDatabase;

const status = new StatusRepository();
const changelog = new ChangelogRepository();
let leads: MarketingLeadsRepository;

/** A fixed clock the whole suite dates from, so ordering never depends on when the test ran. */
const EPOCH = new Date('2026-09-01T00:00:00.000Z');

/** `EPOCH + minutes`, as a bound instant. */
function at(minutes: number): Date {
  return new Date(EPOCH.getTime() + minutes * 60_000);
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

interface IncidentSeed {
  component?: string;
  status?: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  title?: string;
  body?: string;
  startedAt: Date;
  resolvedAt?: Date | null;
  published: boolean;
}

/**
 * Insert one incident through the admin pool (the public slice ships no write path), dating every
 * instant from a bound `Date` so the SYSTEM clock never decides order. Returns the row's id.
 */
async function seedIncident(seed: IncidentSeed): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into incidents
       (id, component, status, title, body, started_at, resolved_at, published, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      seed.component ?? 'API',
      seed.status ?? 'investigating',
      seed.title ?? 'Elevated error rate',
      seed.body ?? 'We are investigating.',
      seed.startedAt,
      seed.resolvedAt ?? null,
      seed.published,
      at(0),
    ],
  );
  return id;
}

interface ChangelogSeed {
  id?: string;
  version?: string;
  title?: string;
  bodyMd?: string;
  category?: string;
  published: boolean;
  publishedAt: Date | null;
}

/** Insert one changelog entry through the admin pool, dating from bound instants. Returns its id. */
async function seedChangelog(seed: ChangelogSeed): Promise<string> {
  const id = seed.id ?? uuidv7();
  await db.admin.execute(
    `insert into changelog_entries
       (id, version, title, body_md, category, published, published_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      seed.version ?? '2026.09',
      seed.title ?? 'Shipped a thing',
      seed.bodyMd ?? '## It shipped',
      seed.category ?? 'feature',
      seed.published,
      seed.publishedAt,
      at(0),
    ],
  );
  return id;
}

/** Read published incidents the way the public controller does — the identity path, over `incidents`. */
async function readIncidents(
  limit = MAX_INCIDENTS,
): ReturnType<StatusRepository['listPublishedIncidents']> {
  return tenant.identityRead({ correlationId: uuidv7(), tables: ['incidents'] }, (runner) =>
    status.listPublishedIncidents(runner, limit),
  );
}

/** Read published changelog entries the way the public controller does. */
async function readChangelog(limit: number): ReturnType<ChangelogRepository['listPublished']> {
  return tenant.identityRead({ correlationId: uuidv7(), tables: ['changelog_entries'] }, (runner) =>
    changelog.listPublished(runner, limit),
  );
}

async function clearTables(): Promise<void> {
  await db.admin.query('TRUNCATE TABLE incidents');
  await db.admin.query('TRUNCATE TABLE changelog_entries');
  await db.admin.query('TRUNCATE TABLE marketing_leads');
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  await clearTables();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  leads = new MarketingLeadsRepository(tenant);
});

afterAll(async () => {
  await db?.stop();
});

describe('the public status read', () => {
  it('round-trips a published incident and never returns a draft', async () => {
    await clearTables();
    const publishedId = await seedIncident({
      component: 'Uploads',
      status: 'monitoring',
      title: 'Degraded upload throughput',
      body: 'Throughput has recovered and we are monitoring.',
      startedAt: at(10),
      published: true,
    });
    await seedIncident({
      title: 'DRAFT — not for the public',
      body: 'Internal only, never published.',
      startedAt: at(20),
      published: false,
    });

    const rows = await readIncidents();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe(publishedId);
    expect(row?.component).toBe('Uploads');
    expect(row?.status).toBe('monitoring');
    expect(row?.title).toBe('Degraded upload throughput');
    expect(row?.body).toBe('Throughput has recovered and we are monitoring.');
    expect(row?.startedAt.toISOString()).toBe(at(10).toISOString());
    expect(row?.published).toBe(true);

    // The public projection re-holds the boundary: the draft is absent and the `published` flag is
    // not disclosed on the wire.
    const view = toPublicStatus(rows);
    expect(view.overall).toBe('monitoring');
    expect(view.incidents).toHaveLength(1);
    expect(view.incidents[0]?.id).toBe(publishedId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('DRAFT — not for the public');
    expect(serialized).not.toContain('"published"');
  });

  it('orders published incidents newest-first by started_at', async () => {
    await clearTables();
    const oldest = await seedIncident({ title: 'Oldest', startedAt: at(1), published: true });
    const newest = await seedIncident({ title: 'Newest', startedAt: at(3), published: true });
    const middle = await seedIncident({ title: 'Middle', startedAt: at(2), published: true });

    const rows = await readIncidents();
    expect(rows.map((row) => row.id)).toEqual([newest, middle, oldest]);
  });

  it('honours the page bound, keeping the newest incidents', async () => {
    await clearTables();
    await seedIncident({ title: 'A', startedAt: at(1), published: true });
    const b = await seedIncident({ title: 'B', startedAt: at(2), published: true });
    const c = await seedIncident({ title: 'C', startedAt: at(3), published: true });

    const rows = await readIncidents(2);
    expect(rows.map((row) => row.id)).toEqual([c, b]);
  });

  it('reports operational only when every published incident is resolved', async () => {
    await clearTables();
    await seedIncident({
      status: 'resolved',
      title: 'Resolved last week',
      startedAt: at(1),
      resolvedAt: at(5),
      published: true,
    });

    let view = toPublicStatus(await readIncidents());
    expect(view.overall).toBe('operational');
    expect(view.incidents).toHaveLength(1);

    await seedIncident({
      status: 'identified',
      title: 'Active now',
      startedAt: at(10),
      published: true,
    });
    view = toPublicStatus(await readIncidents());
    expect(view.overall).toBe('identified');
  });
});

describe('the public changelog read', () => {
  it('returns only published entries that carry a live date, newest-first with id breaking ties', async () => {
    await clearTables();
    await seedChangelog({ title: 'Draft entry', published: false, publishedAt: null });
    // Published but with no live date — the two-predicate gate must exclude it as well as a draft.
    await seedChangelog({ title: 'Published, no date', published: true, publishedAt: null });
    const older = await seedChangelog({
      title: 'Older live entry',
      published: true,
      publishedAt: at(10),
    });
    // Two entries published in the SAME instant: id desc is the stable tiebreak.
    const tieLow = await seedChangelog({
      id: '00000000-0000-0000-0000-000000000001',
      title: 'Tie — low id',
      published: true,
      publishedAt: at(20),
    });
    const tieHigh = await seedChangelog({
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Tie — high id',
      published: true,
      publishedAt: at(20),
    });

    const rows = await readChangelog(50);
    expect(rows.map((row) => row.id)).toEqual([tieHigh, tieLow, older]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Draft entry');
    expect(serialized).not.toContain('Published, no date');
  });

  it('honours the page bound, keeping the newest entries', async () => {
    await clearTables();
    await seedChangelog({ title: 'c1', published: true, publishedAt: at(1) });
    const c2 = await seedChangelog({ title: 'c2', published: true, publishedAt: at(2) });
    const c3 = await seedChangelog({ title: 'c3', published: true, publishedAt: at(3) });

    const rows = await readChangelog(2);
    expect(rows.map((row) => row.id)).toEqual([c3, c2]);
  });
});

describe('the marketing lead write door', () => {
  it('persists exactly the submitted lead, attributed to its source', async () => {
    await clearTables();
    const { id } = await leads.insert({
      name: 'Dana Prospect',
      email: 'dana@example.com',
      message: 'We would like a demo of TManage for our studio.',
      source: 'contact_form',
      correlationId: uuidv7(),
    });

    const rows = await observe(
      `select id, name, email, message, source, created_at from marketing_leads where id = ?`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.['name'])).toBe('Dana Prospect');
    expect(String(rows[0]?.['email'])).toBe('dana@example.com');
    expect(String(rows[0]?.['message'])).toBe('We would like a demo of TManage for our studio.');
    expect(String(rows[0]?.['source'])).toBe('contact_form');
    expect(rows[0]?.['created_at']).not.toBeNull();

    // The write door is the only lead in the table — nothing else was created as a side effect.
    const counted = await observe(`select count(*) as n from marketing_leads`);
    expect(Number(counted[0]?.['n'])).toBe(1);
  });

  it('refuses to let a public read or write reach, or be declared over, tenant data', async () => {
    // A unit of work may not even DECLARE a tenant table on the identity path.
    await expect(
      tenant.identityRead(
        { correlationId: uuidv7(), tables: ['work_items'] },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);

    // And a statement that strays to a tenant table from a legitimately-declared global unit of work
    // is refused — the public page can never be scoped to one organization's rows.
    await expect(
      tenant.identityRead({ correlationId: uuidv7(), tables: ['incidents'] }, (runner) =>
        runner.query('select id from work_items limit 1'),
      ),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });
});
