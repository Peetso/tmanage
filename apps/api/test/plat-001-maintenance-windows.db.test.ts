import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { IdentityScopeViolation, TenantDatabase } from '../src/common/database/tenant-context.js';
import { MaintenanceWindowsRepository } from '../src/modules/platform/maintenance.repository.js';
import {
  MAX_MAINTENANCE_WINDOWS,
  toPublicMaintenance,
} from '../src/modules/platform/maintenance.controller.js';
import { MAINTENANCE_SEVERITIES } from '../src/common/database/schema.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * PLAT-001 against a real server — Platform states (x185, migration 0080 `maintenance_windows`).
 *
 * `maintenance_windows` is a deliberately GLOBAL, org-less table: a window announces that the whole
 * platform is entering maintenance or a degraded state, and the app shell reads it before any
 * organization is resolved. So the table carries no `organization_id`, is registered in
 * `NON_TENANT_TABLES`, and is reached only through `TenantDatabase.identityRead` /
 * `identityTransaction`. The runtime user holds INSERT only — a window is scheduled and read, never
 * amended in place — so the "state" a window carries (its severity, its bounds, whether it is
 * published) is written once and proved by what the read returns. This suite proves, against real
 * InnoDB rather than the DB-free controller fakes:
 *
 * 1. **A scheduled window persists exactly, with a server-stamped `created_at`.** The write rides the
 *    identity transaction; the read round-trips the message, the severity, the millisecond bounds and
 *    the published flag, and `created_at` is the database's clock, never the caller's.
 * 2. **Every platform-state severity in the closed vocabulary persists** (`info`, `degraded`, `down`),
 *    and the engine's ENUM is the second line of defence — a value outside the set is refused by the
 *    server, not merely by the controller.
 * 3. **Published-only is the engine's gate, not the controller's.** A drafted window (`published = 0`)
 *    is written and present in the table, yet never returned by the repository read, because the
 *    `WHERE published = 1` predicate holds in the SQL.
 * 4. **The `ends_at > now` boundary is the engine's too.** A finished window is excluded; a currently
 *    running one and an upcoming one are returned soonest-starting first, and the public projection
 *    re-applies `starts_at <= now < ends_at` so a future window is never reported active.
 * 5. **No read of this GLOBAL table can be scoped to, or stray into, a tenant's data** — the identity
 *    path refuses a unit of work that even declares a tenant table, and refuses a statement that
 *    reaches one, and the table has no `organization_id` to scope by in the first place.
 *
 * Conventions follow `public-001-site.db.test.ts` (the sibling org-less module). The admin pool clock
 * is SYSTEM, so every window's bounds are dated from a bound `new Date(...)` here, keeping the
 * ordering and boundary assertions independent of the machine clock.
 */

let db: TestDatabase;
let tenant: TenantDatabase;
let repository: MaintenanceWindowsRepository;

/** A fixed clock the whole suite dates window bounds from, so ordering never depends on run time. */
const EPOCH = new Date('2026-09-01T00:00:00.000Z');

/** `EPOCH + minutes`, as a bound instant. */
function at(minutes: number): Date {
  return new Date(EPOCH.getTime() + minutes * 60_000);
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

interface WindowSeed {
  id?: string;
  message?: string;
  severity?: (typeof MAINTENANCE_SEVERITIES)[number];
  startsAt: Date;
  endsAt: Date;
  published: boolean;
}

/**
 * Insert one window directly through the admin pool, dating the bounds from bound `Date`s so the
 * SYSTEM clock never decides visibility or order. Returns the row's id. Used where the point is what
 * is *already in the table* (drafts, ordering), independent of the write path.
 */
async function seedWindow(seed: WindowSeed): Promise<string> {
  const id = seed.id ?? uuidv7();
  await db.admin.execute(
    `insert into maintenance_windows
       (id, message, severity, starts_at, ends_at, published, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      seed.message ?? 'Scheduled maintenance.',
      seed.severity ?? 'info',
      seed.startsAt,
      seed.endsAt,
      seed.published,
      at(0),
    ],
  );
  return id;
}

/** Read publishable windows the way the public controller does — the identity path, over the table. */
async function readWindows(
  now: Date,
  limit = MAX_MAINTENANCE_WINDOWS,
): ReturnType<MaintenanceWindowsRepository['listPublishableWindows']> {
  return tenant.identityRead(
    { correlationId: uuidv7(), tables: ['maintenance_windows'] },
    (runner) => repository.listPublishableWindows(runner, now, limit),
  );
}

async function clearTable(): Promise<void> {
  await db.admin.query('TRUNCATE TABLE maintenance_windows');
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  await clearTable();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  repository = new MaintenanceWindowsRepository(tenant);
});

afterAll(async () => {
  await db?.stop();
});

describe('scheduling a maintenance window', () => {
  it('persists exactly what was scheduled, with a server-stamped created_at', async () => {
    await clearTable();
    const before = Date.now();
    const { id, createdAt } = await repository.insert({
      message: 'Database upgrade — brief read-only period.',
      severity: 'degraded',
      startsAt: at(60),
      endsAt: at(120),
      published: true,
      correlationId: uuidv7(),
    });
    const after = Date.now();

    // The read (soonest-starting, published, not-yet-ended) returns the row verbatim. `now` sits
    // before the window, so it is upcoming rather than active, and still visible.
    const rows = await readWindows(at(0));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe(id);
    expect(row?.message).toBe('Database upgrade — brief read-only period.');
    expect(row?.severity).toBe('degraded');
    expect(row?.startsAt.toISOString()).toBe(at(60).toISOString());
    expect(row?.endsAt.toISOString()).toBe(at(120).toISOString());
    expect(row?.published).toBe(true);

    // created_at is the database's clock (current_timestamp(3)), not EPOCH and not the caller's: it
    // lands within the wall-clock window the write spanned, nowhere near the 2026-09 bounds above.
    expect(createdAt).toBeInstanceOf(Date);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(row?.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it('persists every platform-state severity in the closed vocabulary', async () => {
    await clearTable();
    // Stagger the starts so the read order is deterministic, and keep every window upcoming.
    let offset = 10;
    for (const severity of MAINTENANCE_SEVERITIES) {
      await repository.insert({
        message: `A ${severity} window.`,
        severity,
        startsAt: at(offset),
        endsAt: at(offset + 5),
        published: true,
        correlationId: uuidv7(),
      });
      offset += 10;
    }

    const rows = await readWindows(at(0));
    expect(rows.map((row) => row.severity)).toEqual([...MAINTENANCE_SEVERITIES]);
  });

  it('is refused by the engine for a severity outside the closed vocabulary', async () => {
    await clearTable();
    // The ENUM is the second line of defence behind the controller: under strict mode the server
    // itself rejects a value it does not know, so a bad severity can never land even if a caller
    // bypassed the controller's validation.
    await expect(
      seedWindow({
        severity: 'catastrophic' as (typeof MAINTENANCE_SEVERITIES)[number],
        startsAt: at(10),
        endsAt: at(20),
        published: true,
      }),
    ).rejects.toThrow();
    const counted = await observe('select count(*) as n from maintenance_windows');
    expect(Number(counted[0]?.['n'])).toBe(0);
  });
});

describe('the public maintenance read', () => {
  it('never returns a drafted window, though it persists in the table', async () => {
    await clearTable();
    const publishedId = await seedWindow({
      message: 'Published notice.',
      startsAt: at(10),
      endsAt: at(200),
      published: true,
    });
    await seedWindow({
      message: 'DRAFT — not announced.',
      startsAt: at(20),
      endsAt: at(200),
      published: false,
    });

    const rows = await readWindows(at(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(publishedId);

    // The draft really is in the table — the gate is the SQL predicate, not a missing row — and the
    // public projection does not leak it or the published flag onto the wire.
    const counted = await observe('select count(*) as n from maintenance_windows');
    expect(Number(counted[0]?.['n'])).toBe(2);
    const view = toPublicMaintenance(rows, at(0));
    expect(view.window?.id).toBe(publishedId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('DRAFT — not announced.');
    expect(serialized).not.toContain('"published"');
  });

  it('excludes a finished window and reports the running one as active', async () => {
    await clearTable();
    const now = at(100);
    // Ended before `now`: excluded by `ends_at > now`.
    await seedWindow({ message: 'Ended.', startsAt: at(10), endsAt: at(50), published: true });
    // Running now (starts_at <= now < ends_at): returned and active.
    const active = await seedWindow({
      message: 'Running now.',
      startsAt: at(90),
      endsAt: at(110),
      published: true,
    });
    // Upcoming: returned but not yet active.
    const upcoming = await seedWindow({
      message: 'Later today.',
      startsAt: at(120),
      endsAt: at(130),
      published: true,
    });

    const rows = await readWindows(now);
    // Soonest-starting first: the running window heads the list, the upcoming one follows.
    expect(rows.map((row) => row.id)).toEqual([active, upcoming]);

    const view = toPublicMaintenance(rows, now);
    expect(view.window?.id).toBe(active);
    expect(view.window?.active).toBe(true);
    expect(view.asOf).toBe(now.toISOString());
  });

  it('orders publishable windows soonest-starting first and honours the page bound', async () => {
    await clearTable();
    const first = await seedWindow({ startsAt: at(10), endsAt: at(200), published: true });
    const second = await seedWindow({ startsAt: at(20), endsAt: at(200), published: true });
    await seedWindow({ startsAt: at(30), endsAt: at(200), published: true });

    const rows = await readWindows(at(0), 2);
    expect(rows.map((row) => row.id)).toEqual([first, second]);
  });
});

describe('the global table refuses tenant scope', () => {
  it('carries no organization_id to scope by', async () => {
    const columns = await observe(
      `select column_name from information_schema.columns
       where table_schema = database() and table_name = 'maintenance_windows'`,
    );
    const names = columns.map((row) => String(row['COLUMN_NAME'] ?? row['column_name']));
    expect(names).not.toContain('organization_id');
    // The window's state lives entirely in these columns — global, not tenant-owned.
    expect(new Set(names)).toEqual(
      new Set([
        'id',
        'message',
        'severity',
        'starts_at',
        'ends_at',
        'published',
        'created_at',
        // 0244 (platform-admin v2 · PA-10): Arabic text, the sign-in gate, edits, early end.
        'message_ar',
        'block_sign_in',
        'updated_at',
        'ended_at',
      ]),
    );
  });

  it('refuses a read declared over, or straying into, a tenant table', async () => {
    // A unit of work on the identity path may not even DECLARE a tenant table.
    await expect(
      tenant.identityRead(
        { correlationId: uuidv7(), tables: ['work_items'] },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);

    // And a statement that strays to a tenant table from a legitimately-declared global unit of work
    // is refused — the maintenance read can never be scoped to one organization's rows.
    await expect(
      tenant.identityRead({ correlationId: uuidv7(), tables: ['maintenance_windows'] }, (runner) =>
        runner.query('select id from work_items limit 1'),
      ),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });
});
