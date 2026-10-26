import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import {
  WORKER_OUTBOX_HANDLERS,
  createDueSoonSweepStore,
  createWorkerDatabase,
  runOutboxBatch,
  sweepDueSoon,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * AUT-005 over real HTTP and the worker — C1: rule conditions decide whether a rule fires, a
 * condition can be removed, and the `work_item_due_soon` trigger (migration 0230).
 *
 * 1. **Registry.** `workflow_due_soon_fires` is a tenant table in all four places, written by the
 *    worker alone (INSERT, SELECT where it writes); the app holds DELETE on `workflow_conditions`.
 * 2. **Conditions gate a rule on an event.** A rule whose "Only if" does not hold for the work item
 *    leaves no run row; once the condition is removed (over HTTP, audited) the same rule runs.
 * 3. **The due-soon sweep fires once per item per rule per day**, only for open items inside the
 *    window, only where the conditions hold, and never across a tenant boundary.
 * 4. **The claim's composite keys refuse a cross-tenant rule or item** at the engine.
 * 5. **Gap 10 / H10 — "Skip weekends" holds and delivers in the company's timezone.** A run that
 *    falls on Friday or Saturday on the company's clock (`organizations.timezone`) is held, not
 *    sent; the sweep delivers it once that clock reads Sunday 08:00, with the original dedupe key;
 *    a re-run sends nothing twice. Only `Date` is faked, so the pool, the timers and the database's
 *    own `now(3)` stay real (the held-run age window and the claim's `fire_date` read the database).
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let workerDb: WorkerDatabase;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';

const OUTBOX_OPTIONS = {
  batchSize: 50,
  maxAttempts: 3,
  backoffBaseMs: 60_000,
  backoffCapMs: 900_000,
};

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

/** The automation tables `truncateAll` does not know; cleared so each test starts empty. */
async function truncateAutomations(): Promise<void> {
  await db.admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'workflow_due_soon_fires',
      'workflow_runs',
      'workflow_conditions',
      'workflow_templates',
    ]) {
      await db.admin.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await db.admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

async function rule(
  organizationId: string,
  createdBy: string,
  triggerKind: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into workflow_templates
       (id, organization_id, name, trigger_kind, action_kind, config_json, enabled, created_by)
     values (?, ?, ?, ?, 'notify_owner', ?, 1, ?)`,
    [id, organizationId, `Rule ${triggerKind}`, triggerKind, JSON.stringify(config), createdBy],
  );
  return id;
}

/** A work item due `days` from the database's now (whole days, so the session zone cannot matter). */
async function itemDueIn(
  organizationId: string,
  projectId: string,
  ownerUserId: string,
  days: number | null,
  state = 'in_progress',
): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into work_items (id, organization_id, project_id, title, state, owner_user_id, due_at)
     values (?, ?, ?, ?, ?, ?,
             case when ? is null then null else date_add(current_timestamp(3), interval ? day) end)`,
    [id, organizationId, projectId, `Due ${String(days)}`, state, ownerUserId, days, days ?? 0],
  );
  return id;
}

async function runsOf(templateId: string): Promise<RowDataPacket[]> {
  return observe('select id, organization_id, status from workflow_runs where template_id = ?', [
    templateId,
  ]);
}

async function claimsOf(templateId: string): Promise<RowDataPacket[]> {
  return observe(
    'select organization_id, work_item_id from workflow_due_soon_fires where template_id = ?',
    [templateId],
  );
}

async function emitCreated(organizationId: string, workItemId: string): Promise<void> {
  await db.admin.execute(
    `insert into outbox_events
       (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
        payload_json, occurred_at, available_at)
     values (?, ?, 'work_item.created.v1', 1, 'work_item', ?, ?,
             date_sub(utc_timestamp(3), interval 1 second),
             date_sub(utc_timestamp(3), interval 1 second))`,
    [uuidv7(), organizationId, workItemId, JSON.stringify({ workItemId })],
  );
}

async function drain(): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OUTBOX_OPTIONS);
    expect(report.failed, JSON.stringify(report.failures)).toBe(0);
    if (report.claimed === 0) return;
  }
}

const owner = () => world.northstar.owner;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_aut_005_suite', guardMode: 'enforce' }));
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  await truncateAutomations();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await workerDb?.end();
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('0230 — registry: workflow_due_soon_fires in all four places', () => {
  it('is in TABLES and TENANT_TABLES; users.sql gives it to the worker alone', () => {
    expect(Object.keys(TABLES)).toContain('workflow_due_soon_fires');
    expect(TENANT_TABLES['workflow_due_soon_fires']).toBe('organization_id');

    const onTable = (user: string, table: string) =>
      [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])]
        .filter((key) => key.startsWith(`tmanage.${table}:`))
        .sort();
    expect(onTable('tmanage_worker', 'workflow_due_soon_fires')).toEqual([
      'tmanage.workflow_due_soon_fires:INSERT',
      'tmanage.workflow_due_soon_fires:SELECT',
    ]);
    // The app never writes a claim; it reads through the database-wide SELECT only.
    expect(onTable('tmanage_app', 'workflow_due_soon_fires')).toEqual([]);
    // C1: the app removes a condition, and still never edits one.
    expect(onTable('tmanage_app', 'workflow_conditions')).toEqual([
      'tmanage.workflow_conditions:DELETE',
      'tmanage.workflow_conditions:INSERT',
    ]);
    // The worker reads conditions to decide whether a rule fires, and writes none.
    expect(onTable('tmanage_worker', 'workflow_conditions')).toEqual([
      'tmanage.workflow_conditions:SELECT',
    ]);
  });
});

describe('C1 — conditions gate a rule fired by an event', () => {
  it('skips a rule whose condition does not hold, and runs it once the condition is removed', async () => {
    const templateId = await rule(world.northstar.organizationId, owner().id, 'work_item_created');
    const session = await signIn(owner().id);
    const created = await send('POST', `/automations/templates/${templateId}/conditions`, session, {
      field: 'status',
      op: 'eq',
      value: 'done',
      targetStep: 0,
    });
    expect(created.statusCode, created.body).toBe(201);
    const conditionId = created.json<{ id: string }>().id;

    const first = await itemDueIn(
      world.northstar.organizationId,
      world.northstar.projectId,
      owner().id,
      null,
    );
    await emitCreated(world.northstar.organizationId, first);
    await drain();
    // The item is in progress, the rule asks for done: no run row, as if nothing had happened.
    expect(await runsOf(templateId)).toHaveLength(0);

    const removed = await send(
      'DELETE',
      `/automations/templates/${templateId}/conditions/${conditionId}`,
      session,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await observe('select id from workflow_conditions where id = ?', [conditionId])).toEqual(
      [],
    );
    const audits = await observe(
      `select organization_id from audit_events
        where action = 'workflow_condition.deleted' and object_id = ?`,
      [conditionId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!['organization_id']).toBe(world.northstar.organizationId);

    const second = await itemDueIn(
      world.northstar.organizationId,
      world.northstar.projectId,
      owner().id,
      null,
    );
    await emitCreated(world.northstar.organizationId, second);
    await drain();
    const runs = await runsOf(templateId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!['status']).toBe('succeeded');
  });

  it('runs a rule whose condition holds', async () => {
    const templateId = await rule(world.northstar.organizationId, owner().id, 'work_item_created');
    const session = await signIn(owner().id);
    const created = await send('POST', `/automations/templates/${templateId}/conditions`, session, {
      field: 'project_id',
      op: 'eq',
      value: world.northstar.projectId,
      targetStep: 0,
    });
    expect(created.statusCode, created.body).toBe(201);

    const item = await itemDueIn(
      world.northstar.organizationId,
      world.northstar.projectId,
      owner().id,
      null,
    );
    await emitCreated(world.northstar.organizationId, item);
    await drain();
    expect(await runsOf(templateId)).toHaveLength(1);
  });

  it('gives the adversarial twin a 404 for Northstar’s condition and removes nothing', async () => {
    const templateId = await rule(world.northstar.organizationId, owner().id, 'work_item_created');
    const session = await signIn(owner().id);
    const created = await send('POST', `/automations/templates/${templateId}/conditions`, session, {
      field: 'status',
      op: 'eq',
      value: 'done',
      targetStep: 0,
    });
    const conditionId = created.json<{ id: string }>().id;

    const twin = await signIn(world.twin.owner.id);
    const response = await send(
      'DELETE',
      `/automations/templates/${templateId}/conditions/${conditionId}`,
      twin,
      undefined,
      TWIN,
    );
    expect(response.statusCode).toBe(404);
    expect(
      await observe('select id from workflow_conditions where id = ?', [conditionId]),
    ).toHaveLength(1);
  });

  it('refuses a member without org.manage with a 403 and keeps the condition', async () => {
    const templateId = await rule(world.northstar.organizationId, owner().id, 'work_item_created');
    const session = await signIn(owner().id);
    const created = await send('POST', `/automations/templates/${templateId}/conditions`, session, {
      field: 'status',
      op: 'eq',
      value: 'done',
      targetStep: 0,
    });
    const conditionId = created.json<{ id: string }>().id;

    const designer = await signIn(world.northstar.designer.id);
    const response = await send(
      'DELETE',
      `/automations/templates/${templateId}/conditions/${conditionId}`,
      designer,
    );
    expect(response.statusCode).toBe(403);
    expect(
      await observe('select id from workflow_conditions where id = ?', [conditionId]),
    ).toHaveLength(1);
  });
});

describe('0230 — the due-soon sweep', () => {
  it('fires for open items inside the window, once per item per day', async () => {
    const org = world.northstar.organizationId;
    const project = world.northstar.projectId;
    const templateId = await rule(org, owner().id, 'work_item_due_soon');
    const soon = await itemDueIn(org, project, owner().id, 1);
    await itemDueIn(org, project, owner().id, 10); // outside "due in 2 days"
    await itemDueIn(org, project, owner().id, -1); // already overdue
    await itemDueIn(org, project, owner().id, 1, 'done'); // closed

    const first = await sweepDueSoon(createDueSoonSweepStore(workerDb));
    expect(first).toEqual({ rules: 1, fired: 1, delivered: 0 });
    expect((await claimsOf(templateId)).map((row) => row['work_item_id'])).toEqual([soon]);
    expect(await runsOf(templateId)).toHaveLength(1);
    const notices = await observe(
      `select recipient_user_id from notifications
        where organization_id = ? and type = 'automation.notified.v1' and object_id = ?`,
      [org, soon],
    );
    expect(notices.map((row) => row['recipient_user_id'])).toEqual([owner().id]);

    // Idempotent for the day: the claim exists, so nothing runs again.
    const second = await sweepDueSoon(createDueSoonSweepStore(workerDb));
    expect(second).toEqual({ rules: 1, fired: 0, delivered: 0 });
    expect(await claimsOf(templateId)).toHaveLength(1);
    expect(await runsOf(templateId)).toHaveLength(1);
  });

  it('honours the rule’s conditions and its own window', async () => {
    const org = world.northstar.organizationId;
    const gated = await rule(org, owner().id, 'work_item_due_soon');
    const wide = await rule(org, owner().id, 'work_item_due_soon', { dueInDays: 14 });
    const session = await signIn(owner().id);
    const created = await send('POST', `/automations/templates/${gated}/conditions`, session, {
      field: 'project_id',
      op: 'eq',
      value: world.northstar.otherProjectId,
      targetStep: 0,
    });
    expect(created.statusCode, created.body).toBe(201);

    await itemDueIn(org, world.northstar.projectId, owner().id, 1);
    const later = await itemDueIn(org, world.northstar.projectId, owner().id, 10);

    const result = await sweepDueSoon(createDueSoonSweepStore(workerDb));
    expect(result.rules).toBe(2);
    // The gated rule wants the other project: nothing claimed, nothing run.
    expect(await claimsOf(gated)).toHaveLength(0);
    expect(await runsOf(gated)).toHaveLength(0);
    // The 14-day rule sees both items.
    const claimed = (await claimsOf(wide)).map((row) => String(row['work_item_id']));
    expect(claimed).toHaveLength(2);
    expect(claimed).toContain(later);
  });

  it('keeps each tenant’s rule on its own items', async () => {
    const nsRule = await rule(world.northstar.organizationId, owner().id, 'work_item_due_soon');
    const twRule = await rule(world.twin.organizationId, world.twin.owner.id, 'work_item_due_soon');
    const nsItem = await itemDueIn(
      world.northstar.organizationId,
      world.northstar.projectId,
      owner().id,
      1,
    );
    const twItem = await itemDueIn(
      world.twin.organizationId,
      world.twin.projectId,
      world.twin.owner.id,
      1,
    );

    await sweepDueSoon(createDueSoonSweepStore(workerDb));
    expect(await claimsOf(nsRule)).toEqual([
      { organization_id: world.northstar.organizationId, work_item_id: nsItem },
    ]);
    expect(await claimsOf(twRule)).toEqual([
      { organization_id: world.twin.organizationId, work_item_id: twItem },
    ]);
  });

  it('skips a deleted or disabled rule', async () => {
    const org = world.northstar.organizationId;
    const deleted = await rule(org, owner().id, 'work_item_due_soon');
    const disabled = await rule(org, owner().id, 'work_item_due_soon');
    await db.admin.execute('update workflow_templates set deleted_at = now(3) where id = ?', [
      deleted,
    ]);
    await db.admin.execute('update workflow_templates set enabled = 0 where id = ?', [disabled]);
    await itemDueIn(org, world.northstar.projectId, owner().id, 1);

    const result = await sweepDueSoon(createDueSoonSweepStore(workerDb));
    expect(result).toEqual({ rules: 0, fired: 0, delivered: 0 });
    expect(await observe('select id from workflow_due_soon_fires')).toHaveLength(0);
  });
});

describe('0230 — the claim cannot cross a tenant', () => {
  it('refuses a claim naming another tenant’s rule or item', async () => {
    const nsRule = await rule(world.northstar.organizationId, owner().id, 'work_item_due_soon');
    // Northstar's organization with the twin's work item.
    await expect(
      db.admin.execute(
        `insert into workflow_due_soon_fires (id, organization_id, template_id, work_item_id, fire_date)
         values (?, ?, ?, ?, current_date)`,
        [uuidv7(), world.northstar.organizationId, nsRule, world.twin.workItemId],
      ),
    ).rejects.toThrow(/foreign key/i);
    // The twin's organization naming Northstar's rule.
    await expect(
      db.admin.execute(
        `insert into workflow_due_soon_fires (id, organization_id, template_id, work_item_id, fire_date)
         values (?, ?, ?, ?, current_date)`,
        [uuidv7(), world.twin.organizationId, nsRule, world.twin.workItemId],
      ),
    ).rejects.toThrow(/foreign key/i);
    expect(await observe('select id from workflow_due_soon_fires')).toHaveLength(0);
  });

  it('collides on a second claim for the same rule, item and day', async () => {
    const nsRule = await rule(world.northstar.organizationId, owner().id, 'work_item_due_soon');
    const insert = () =>
      db.admin.execute(
        `insert into workflow_due_soon_fires (id, organization_id, template_id, work_item_id, fire_date)
         values (?, ?, ?, ?, current_date)`,
        [uuidv7(), world.northstar.organizationId, nsRule, world.northstar.workItemId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Riyadh is UTC+3 all year (no daylight saving), and its studio week ends on Friday and Saturday.
 * Each instant below is chosen so that the UTC reading and the company reading disagree where it
 * matters: Thursday night in UTC is already Friday in Riyadh, and Sunday 05:00 in UTC is Sunday
 * 08:00 — the delivery hour — in Riyadh.
 */
const COMPANY_ZONE = 'Asia/Riyadh';
const THU_UTC_FRI_COMPANY = '2026-10-22T21:30:00Z'; // Riyadh Fri 00:30, UTC Thu 21:30
const SAT_LATE_COMPANY = '2026-10-24T20:00:00Z'; // Riyadh Sat 23:00
const SUN_BEFORE_EIGHT = '2026-10-25T04:59:00Z'; // Riyadh Sun 07:59
const SUN_EIGHT_COMPANY = '2026-10-25T05:00:00Z'; // Riyadh Sun 08:00, UTC Sun 05:00
const SUN_NOON_COMPANY = '2026-10-25T09:00:00Z'; // Riyadh Sun 12:00

/** Run `work` with the process clock (only `Date`) bound to `iso`. */
async function at<T>(iso: string, work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

function sweep() {
  return sweepDueSoon(createDueSoonSweepStore(workerDb));
}

async function setZone(organizationId: string, zone: string): Promise<void> {
  await db.admin.execute('update organizations set timezone = ? where id = ?', [
    zone,
    organizationId,
  ]);
}

interface RunDetail {
  readonly id: string;
  readonly status: string;
  readonly detail: Record<string, unknown>;
}

async function runDetails(templateId: string): Promise<RunDetail[]> {
  const rows = await observe(
    'select id, status, detail_json from workflow_runs where template_id = ? order by started_at, id',
    [templateId],
  );
  return rows.map((row) => {
    const raw: unknown = row['detail_json'];
    const detail = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    return { id: String(row['id']), status: String(row['status']), detail };
  });
}

async function automationNotices(organizationId: string, objectId: string) {
  return observe(
    `select recipient_user_id, dedupe_key from notifications
      where organization_id = ? and type = 'automation.notified.v1' and object_id = ?`,
    [organizationId, objectId],
  );
}

describe('Gap 10 / H10 — weekend hold in the company timezone, delivered on Sunday, once', () => {
  it('holds a due-soon run that is Friday in the company zone, while a UTC company is told at once', async () => {
    const ns = world.northstar.organizationId;
    const tw = world.twin.organizationId;
    await setZone(ns, COMPANY_ZONE);
    await setZone(tw, 'UTC');
    const nsRule = await rule(ns, owner().id, 'work_item_due_soon', { skipWeekends: true });
    const twRule = await rule(tw, world.twin.owner.id, 'work_item_due_soon', {
      skipWeekends: true,
    });
    const nsItem = await itemDueIn(ns, world.northstar.projectId, owner().id, 1);
    const twItem = await itemDueIn(tw, world.twin.projectId, world.twin.owner.id, 1);

    const result = await at(THU_UTC_FRI_COMPANY, sweep);
    expect(result).toEqual({ rules: 2, fired: 2, delivered: 0 });

    // Riyadh: Friday 00:30 — held, with what the Sunday delivery needs; nobody told.
    const nsRuns = await runDetails(nsRule);
    expect(nsRuns).toHaveLength(1);
    const held = nsRuns[0]!;
    expect(held.status).toBe('failed');
    expect(held.detail).toMatchObject({
      outcome: 'not_run',
      reason: 'held_for_weekend',
      heldObjectType: 'work_item',
      heldObjectId: nsItem,
      heldProjectId: world.northstar.projectId,
    });
    const [claim] = await observe(
      'select id from workflow_due_soon_fires where template_id = ? and work_item_id = ?',
      [nsRule, nsItem],
    );
    expect(held.detail['heldEventId']).toBe(claim!['id']);
    expect(await automationNotices(ns, nsItem)).toHaveLength(0);

    // UTC: still Thursday 21:30 — the same rule runs and tells the owner now.
    const twRuns = await runDetails(twRule);
    expect(twRuns.map((run) => run.status)).toEqual(['succeeded']);
    expect(twRuns[0]!.detail['reason']).toBeUndefined();
    expect((await automationNotices(tw, twItem)).map((row) => row['recipient_user_id'])).toEqual([
      world.twin.owner.id,
    ]);
  });

  it('delivers the held run at Sunday 08:00 company time, with the original dedupe key, and never twice', async () => {
    const ns = world.northstar.organizationId;
    await setZone(ns, COMPANY_ZONE);
    const templateId = await rule(ns, owner().id, 'work_item_due_soon', { skipWeekends: true });
    const item = await itemDueIn(ns, world.northstar.projectId, owner().id, 1);

    expect(await at(THU_UTC_FRI_COMPANY, sweep)).toEqual({ rules: 1, fired: 1, delivered: 0 });
    const held = (await runDetails(templateId))[0]!;
    expect(held.detail['reason']).toBe('held_for_weekend');

    // Saturday night and Sunday 07:59 on the company clock: still held, nothing sent.
    expect((await at(SAT_LATE_COMPANY, sweep)).delivered).toBe(0);
    expect((await at(SUN_BEFORE_EIGHT, sweep)).delivered).toBe(0);
    expect(await runDetails(templateId)).toHaveLength(1);
    expect(await automationNotices(ns, item)).toHaveLength(0);

    // Sunday 08:00 in Riyadh (05:00 UTC, which a UTC reading would still hold): delivered.
    expect(await at(SUN_EIGHT_COMPANY, sweep)).toEqual({ rules: 1, fired: 0, delivered: 1 });
    const runs = await runDetails(templateId);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.status).toBe('succeeded');
    expect(runs[1]!.detail).toMatchObject({ outcome: 'executed', heldRunId: held.id });
    expect(String(runs[1]!.detail['effect'])).toContain('on Sunday morning, after the weekend');
    expect(await automationNotices(ns, item)).toEqual([
      {
        recipient_user_id: owner().id,
        dedupe_key: `automation:${templateId}:${String(held.detail['heldEventId'])}`,
      },
    ]);

    // Re-runs later on Sunday: the held run is already closed — no run, no second notice.
    expect(await at(SUN_EIGHT_COMPANY, sweep)).toEqual({ rules: 1, fired: 0, delivered: 0 });
    expect(await at(SUN_NOON_COMPANY, sweep)).toEqual({ rules: 1, fired: 0, delivered: 0 });
    expect(await runDetails(templateId)).toHaveLength(2);
    expect(await automationNotices(ns, item)).toHaveLength(1);
  });

  it('holds an event-triggered run on the company Friday and delivers it through the sweep on Sunday', async () => {
    const ns = world.northstar.organizationId;
    await setZone(ns, COMPANY_ZONE);
    const templateId = await rule(ns, owner().id, 'work_item_created', { skipWeekends: true });
    const item = await itemDueIn(ns, world.northstar.projectId, owner().id, null);
    await emitCreated(ns, item);
    const [event] = await observe(
      'select id from outbox_events where organization_id = ? and aggregate_id = ?',
      [ns, item],
    );
    const eventId = String(event!['id']);

    await at(THU_UTC_FRI_COMPANY, drain);
    const held = (await runDetails(templateId))[0]!;
    expect(held.detail).toMatchObject({ reason: 'held_for_weekend', heldEventId: eventId });
    expect(await automationNotices(ns, item)).toHaveLength(0);

    // The due-soon sweep delivers every "Skip weekends" rule's held runs, whatever the trigger.
    expect((await at(SUN_EIGHT_COMPANY, sweep)).delivered).toBe(1);
    expect((await at(SUN_NOON_COMPANY, sweep)).delivered).toBe(0);
    expect(await automationNotices(ns, item)).toEqual([
      { recipient_user_id: owner().id, dedupe_key: `automation:${templateId}:${eventId}` },
    ]);
    const runs = await runDetails(templateId);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'succeeded']);
    expect(runs[1]!.detail['heldRunId']).toBe(held.id);
  });

  it('delivers nothing for a rule switched off before Sunday', async () => {
    const ns = world.northstar.organizationId;
    await setZone(ns, COMPANY_ZONE);
    const templateId = await rule(ns, owner().id, 'work_item_due_soon', { skipWeekends: true });
    const item = await itemDueIn(ns, world.northstar.projectId, owner().id, 1);
    await at(THU_UTC_FRI_COMPANY, sweep);
    await db.admin.execute('update workflow_templates set enabled = 0 where id = ?', [templateId]);

    expect(await at(SUN_EIGHT_COMPANY, sweep)).toEqual({ rules: 0, fired: 0, delivered: 0 });
    expect(await runDetails(templateId)).toHaveLength(1);
    expect(await automationNotices(ns, item)).toHaveLength(0);
  });
});
