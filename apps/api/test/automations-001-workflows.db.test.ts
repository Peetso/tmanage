import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { WorkflowTemplatesRepository } from '../src/modules/automations/templates.repository.js';
import { WorkflowRunsRepository } from '../src/modules/automations/run.repository.js';
import { WorkflowConditionsRepository } from '../src/modules/automations/conditions.repository.js';
import { IntegrationConnectionsRepository } from '../src/modules/automations/directory.repository.js';
import { WebhooksRepository } from '../src/modules/automations/webhooks.repository.js';
import { AutomationSchedulesRepository } from '../src/modules/automations/schedules.repository.js';
import { WebhookDeliveriesRepository } from '../src/modules/automations/webhook-deliveries.repository.js';
import { computeNextRunAt } from '../src/modules/automations/next-run.js';
import type { ScheduleSpec } from '../src/modules/automations/next-run.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * T006 — the Automations & integrations data layer (module 17) against a real MySQL server and the
 * §11 adversarial near-identical tenant pair. Seven tables are under test: workflow_templates (0063),
 * workflow_runs (0064), integration_connections (0065), webhook_endpoints (0066),
 * automation_schedules (0067), workflow_conditions (0081), webhook_deliveries (0097).
 *
 * What only this suite can prove, over real InnoDB rather than fakes:
 *
 * 1. **Tenant isolation is structural, not conventional.** A tenant sees only its own templates,
 *    runs, connections, webhooks, schedules, conditions and deliveries; the twin's rows resolve to
 *    null / 0 rows and never appear in a list — even though the twin's organization id differs from
 *    Northstar's in the final hex digit only, so a dropped predicate would leak rather than pass.
 * 2. **A child cannot reference a template across the tenant boundary.** A run, a condition and a
 *    schedule each carry the composite `(organization_id, template_id)` foreign key; pointing one at a
 *    template that lives in another org is refused by the engine, not by the application.
 * 3. **A workflow run is append-only history.** Recording successive runs for one template grows the
 *    ledger; the identity of a run (its org and its template) is immutable at the engine, so a direct
 *    session cannot rewrite which template a recorded run executed.
 * 4. **A schedule's next-run is computed from a bound `Date`, never the connection clock.** The admin
 *    pool clock is SYSTEM; the stored `next_run_at` is exactly the instant `computeNextRunAt` derived
 *    from its inputs, a fixed historical instant unrelated to when the row was written.
 * 5. **A condition belongs to exactly one template.** It is listed under its own template and no
 *    other, and reads back carrying that one `template_id`.
 *
 * Fixtures are built in-test through the repositories (the SQL layer under test), exactly as the SQL
 * layer runs in production; the admin pool is used only to observe what actually landed and to drive
 * the engine-level immutability trigger that no runtime credential can reach.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;

const templates = new WorkflowTemplatesRepository();
const runs = new WorkflowRunsRepository();
const conditions = new WorkflowConditionsRepository();
const connections = new IntegrationConnectionsRepository();
const webhooks = new WebhooksRepository();
const schedules = new AutomationSchedulesRepository();
const deliveries = new WebhookDeliveriesRepository();

/** A 64-char hex digest shape, as `secret_hash CHAR(64)` requires. Never a real secret. */
const SECRET_HASH = 'a'.repeat(64);

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-09-19',
    correlationId: uuidv7(),
  });

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/**
 * Empty the seven automation tables. `truncateAll` (support/*, not editable here) does not know
 * these tables, so a prior run's rows would otherwise survive its wipe of organizations/users and
 * leave orphans. TRUNCATE with FK checks off, child-order-independent.
 */
async function truncateAutomations(admin: Pool): Promise<void> {
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'webhook_deliveries',
      'workflow_runs',
      'workflow_conditions',
      'automation_schedules',
      'workflow_templates',
      'integration_connections',
      'webhook_endpoints',
    ]) {
      await admin.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

// Shared fixtures: one of each entity in each tenant.
let nsTemplate: string;
let nsTemplateB: string;
let twTemplate: string;
let nsRun: string;
let twRun: string;
let nsConnection: string;
let twConnection: string;
let nsWebhook: string;
let twWebhook: string;
let nsSchedule: string;
let twSchedule: string;
let nsCondition: string;
let twCondition: string;
let twDelivery: string;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  await truncateAutomations(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);

  // ── Northstar ──────────────────────────────────────────────────────────────
  nsTemplate = (
    await tenant.transaction(northstar, (tx) =>
      templates.create(tx, northstar, {
        name: 'Nightly booking digest',
        triggerKind: 'work_item_created',
        actionKind: 'notify_owner',
        config: { channel: 'ops' },
        enabled: true,
        createdBy: world.northstar.owner.id,
      }),
    )
  ).id;
  nsTemplateB = (
    await tenant.transaction(northstar, (tx) =>
      templates.create(tx, northstar, {
        name: 'Weekly rollup',
        triggerKind: 'work_item_transitioned',
        actionKind: 'create_work_item',
        config: {},
        enabled: true,
        createdBy: world.northstar.owner.id,
      }),
    )
  ).id;
  nsRun = (
    await tenant.transaction(northstar, (tx) =>
      runs.record(tx, northstar, {
        templateId: nsTemplate,
        status: 'succeeded',
        detail: { outcome: 'executed' },
      }),
    )
  ).id;
  nsConnection = (
    await tenant.transaction(northstar, (tx) =>
      connections.create(tx, northstar, {
        appId: 'slack',
        label: 'Ops Slack',
        status: 'connected',
        config: { workspace: 'northstar' },
        createdBy: world.northstar.owner.id,
      }),
    )
  ).id;
  nsWebhook = (
    await tenant.transaction(northstar, (tx) =>
      webhooks.create(tx, northstar, {
        url: 'https://hooks.northstar.example/ingest',
        eventKind: 'work.created',
        secretHash: SECRET_HASH,
        createdBy: world.northstar.owner.id,
      }),
    )
  ).id;
  nsSchedule = (
    await tenant.transaction(northstar, (tx) =>
      schedules.create(tx, northstar, {
        templateId: nsTemplate,
        spec: { interval: 'daily', hour: 9 },
        nextRunAt: new Date('2026-03-15T09:00:00.000Z'),
        enabled: true,
      }),
    )
  ).id;
  nsCondition = (
    await tenant.transaction(northstar, (tx) =>
      conditions.create(tx, northstar, {
        templateId: nsTemplate,
        field: 'priority',
        op: 'eq',
        value: 'high',
        targetStep: 0,
        createdBy: world.northstar.owner.id,
      }),
    )
  ).id;

  // ── Northstar Studios — the adversarial twin ─────────────────────────────────
  twTemplate = (
    await tenant.transaction(twin, (tx) =>
      templates.create(tx, twin, {
        name: 'Nightly booking digest',
        triggerKind: 'work_item_created',
        actionKind: 'notify_owner',
        config: { channel: 'ops' },
        enabled: true,
        createdBy: world.twin.owner.id,
      }),
    )
  ).id;
  twRun = (
    await tenant.transaction(twin, (tx) =>
      runs.record(tx, twin, {
        templateId: twTemplate,
        status: 'succeeded',
        detail: { outcome: 'executed' },
      }),
    )
  ).id;
  twConnection = (
    await tenant.transaction(twin, (tx) =>
      connections.create(tx, twin, {
        appId: 'slack',
        label: 'Ops Slack',
        status: 'connected',
        config: { workspace: 'twin' },
        createdBy: world.twin.owner.id,
      }),
    )
  ).id;
  twWebhook = (
    await tenant.transaction(twin, (tx) =>
      webhooks.create(tx, twin, {
        url: 'https://hooks.twin.example/ingest',
        eventKind: 'work.created',
        secretHash: SECRET_HASH,
        createdBy: world.twin.owner.id,
      }),
    )
  ).id;
  twSchedule = (
    await tenant.transaction(twin, (tx) =>
      schedules.create(tx, twin, {
        templateId: twTemplate,
        spec: { interval: 'daily', hour: 9 },
        nextRunAt: new Date('2026-03-15T09:00:00.000Z'),
        enabled: true,
      }),
    )
  ).id;
  twCondition = (
    await tenant.transaction(twin, (tx) =>
      conditions.create(tx, twin, {
        templateId: twTemplate,
        field: 'priority',
        op: 'eq',
        value: 'high',
        targetStep: 0,
        createdBy: world.twin.owner.id,
      }),
    )
  ).id;
  twDelivery = await tenant.transaction(twin, (tx) =>
    deliveries.record(tx, twin, {
      endpointId: twWebhook,
      status: 'failure',
      responseCode: null,
    }),
  );
  void twRun;
  void twConnection;
  void twSchedule;
  void twDelivery;
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

describe('a tenant sees only its own automation rows; the twin resolves to null / 0', () => {
  it('templates: list excludes the twin, findById(twin) is null, and really exists for the twin', async () => {
    const mine = await tenant.read(northstar, (tx) => templates.list(tx, northstar));
    const ids = mine.map((row) => row.id);
    expect(ids).toContain(nsTemplate);
    expect(ids).toContain(nsTemplateB);
    expect(ids).not.toContain(twTemplate);

    expect(
      await tenant.read(northstar, (tx) => templates.findById(tx, northstar, twTemplate)),
    ).toBeNull();
    // findByName matches on (organization_id, name): the twin's identically-named template is invisible.
    const sameName = await tenant.read(northstar, (tx) =>
      templates.findByName(tx, northstar, 'Nightly booking digest'),
    );
    expect(sameName?.id).toBe(nsTemplate);
    // It genuinely exists for its own tenant.
    expect((await tenant.read(twin, (tx) => templates.findById(tx, twin, twTemplate)))?.id).toBe(
      twTemplate,
    );
  });

  it('runs: findById(twin) is null, and resolves for the twin', async () => {
    expect(await tenant.read(northstar, (tx) => runs.findById(tx, northstar, twRun))).toBeNull();
    expect((await tenant.read(twin, (tx) => runs.findById(tx, twin, twRun)))?.id).toBe(twRun);
  });

  it('connections: list excludes the twin and findById(twin) is null', async () => {
    const mine = await tenant.read(northstar, (tx) => connections.list(tx, northstar));
    expect(mine.map((row) => row.id)).toContain(nsConnection);
    expect(mine.map((row) => row.id)).not.toContain(twConnection);
    expect(
      await tenant.read(northstar, (tx) => connections.findById(tx, northstar, twConnection)),
    ).toBeNull();
  });

  it('webhooks: list excludes the twin, findById(twin) is null, and a cross-tenant toggle changes nothing', async () => {
    const mine = await tenant.read(northstar, (tx) => webhooks.list(tx, northstar));
    expect(mine.map((row) => row.id)).toContain(nsWebhook);
    expect(mine.map((row) => row.id)).not.toContain(twWebhook);
    expect(
      await tenant.read(northstar, (tx) => webhooks.findById(tx, northstar, twWebhook)),
    ).toBeNull();

    // The mutate path is scoped too: toggling the twin's endpoint under Northstar's context updates
    // zero rows and reads back null, and the twin's row is untouched.
    const toggled = await tenant.transaction(northstar, (tx) =>
      webhooks.setEnabled(tx, northstar, twWebhook, false),
    );
    expect(toggled).toBeNull();
    const stillEnabled = await observe('select enabled from webhook_endpoints where id = ?', [
      twWebhook,
    ]);
    expect(Number(stillEnabled[0]?.['enabled'])).toBe(1);
  });

  it('schedules: list excludes the twin and findById(twin) is null; templateExists is tenant-scoped', async () => {
    const mine = await tenant.read(northstar, (tx) => schedules.list(tx, northstar));
    expect(mine.map((row) => row.id)).toContain(nsSchedule);
    expect(mine.map((row) => row.id)).not.toContain(twSchedule);
    expect(
      await tenant.read(northstar, (tx) => schedules.findById(tx, northstar, twSchedule)),
    ).toBeNull();

    // Northstar's own template exists for it; the twin's does not — the 404-before-FK resolution.
    expect(
      await tenant.read(northstar, (tx) => schedules.templateExists(tx, northstar, nsTemplate)),
    ).toBe(true);
    expect(
      await tenant.read(northstar, (tx) => schedules.templateExists(tx, northstar, twTemplate)),
    ).toBe(false);
  });

  it('conditions: listForTemplate(twin template) is empty under Northstar, and findById(twin) is null', async () => {
    // Northstar cannot read the twin's conditions even naming the twin's template id.
    const viaTwinTemplate = await tenant.read(northstar, (tx) =>
      conditions.listForTemplate(tx, northstar, twTemplate),
    );
    expect(viaTwinTemplate).toHaveLength(0);
    expect(
      await tenant.read(northstar, (tx) => conditions.findById(tx, northstar, twCondition)),
    ).toBeNull();
  });

  it('deliveries: findEndpoint(twin) is null and listByEndpoint(twin) is empty under Northstar', async () => {
    expect(
      await tenant.read(northstar, (tx) => deliveries.findEndpoint(tx, northstar, twWebhook)),
    ).toBeNull();
    const rows = await tenant.read(northstar, (tx) =>
      deliveries.listByEndpoint(tx, northstar, twWebhook, { limit: 50 }),
    );
    expect(rows).toHaveLength(0);
    // The twin can read its own delivery.
    const own = await tenant.read(twin, (tx) =>
      deliveries.listByEndpoint(tx, twin, twWebhook, { limit: 50 }),
    );
    expect(own.map((row) => row.id)).toContain(twDelivery);
  });
});

describe('a child cannot reference a template across the tenant boundary', () => {
  it('a run cannot be recorded against another org’s template', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        runs.record(tx, northstar, {
          templateId: twTemplate,
          status: 'succeeded',
          detail: {},
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('a condition cannot gate another org’s template', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        conditions.create(tx, northstar, {
          templateId: twTemplate,
          field: 'priority',
          op: 'eq',
          value: 'high',
          targetStep: 0,
          createdBy: world.northstar.owner.id,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('a schedule cannot point at another org’s template', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        schedules.create(tx, northstar, {
          templateId: twTemplate,
          spec: { interval: 'daily', hour: 9 },
          nextRunAt: new Date('2026-03-15T09:00:00.000Z'),
          enabled: true,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('a delivery cannot reference another org’s endpoint', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        deliveries.record(tx, northstar, {
          endpointId: twWebhook,
          status: 'success',
          responseCode: 200,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });
});

describe('a workflow run is append-only history, immutable at the engine', () => {
  it('successive runs for one template grow the ledger, newest-last by start', async () => {
    const template = (
      await tenant.transaction(northstar, (tx) =>
        templates.create(tx, northstar, {
          name: 'Run history probe',
          triggerKind: 'request_submitted',
          actionKind: 'post_message',
          config: {},
          enabled: true,
          createdBy: world.northstar.owner.id,
        }),
      )
    ).id;

    const first = await tenant.transaction(northstar, (tx) =>
      runs.record(tx, northstar, {
        templateId: template,
        status: 'succeeded',
        detail: { outcome: 'executed', effect: 'Posted an in-app message.' },
      }),
    );
    const second = await tenant.transaction(northstar, (tx) =>
      runs.record(tx, northstar, {
        templateId: template,
        status: 'failed',
        detail: { outcome: 'not_run', reason: 'external_action_not_supported_in_app' },
      }),
    );

    expect(second.id).not.toBe(first.id);

    // Both facts stand; neither overwrote the other. History is read oldest-first by start then id.
    const ledger = await observe(
      `select id, status from workflow_runs
         where organization_id = ? and template_id = ?
         order by started_at asc, id asc`,
      [world.northstar.organizationId, template],
    );
    expect(ledger.map((row) => String(row['id']))).toEqual([first.id, second.id]);
    expect(ledger.map((row) => String(row['status']))).toEqual(['succeeded', 'failed']);

    // Both resolve by id within the tenant — a recorded run is never discarded.
    expect(
      (await tenant.read(northstar, (tx) => runs.findById(tx, northstar, first.id)))?.status,
    ).toBe('succeeded');
    expect(
      (await tenant.read(northstar, (tx) => runs.findById(tx, northstar, second.id)))?.status,
    ).toBe('failed');
  });

  it('the engine refuses to rewrite which template a recorded run executed', async () => {
    // The template is a real, same-tenant template, so only the immutability trigger — not the
    // foreign key — can reject this update. Driven through the admin pool: no runtime credential is
    // granted UPDATE on workflow_runs at all.
    await expect(
      db.admin.execute(`update workflow_runs set template_id = ? where id = ?`, [
        nsTemplateB,
        nsRun,
      ]),
    ).rejects.toThrow(/immutable/);

    // And the tenant cannot be rewritten either.
    await expect(
      db.admin.execute(`update workflow_runs set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        nsRun,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('a schedule’s next-run is computed from a bound Date, never the connection clock', () => {
  it('computeNextRunAt is pure and deterministic across intervals', () => {
    const sunday0630 = new Date('2026-03-15T06:30:00.000Z'); // 2026-03-15 is a Sunday (UTC day 0).
    expect(computeNextRunAt({ interval: 'hourly' }, sunday0630).toISOString()).toBe(
      '2026-03-15T07:00:00.000Z',
    );
    expect(computeNextRunAt({ interval: 'daily', hour: 9 }, sunday0630).toISOString()).toBe(
      '2026-03-15T09:00:00.000Z',
    );
    // Already past today's 06:00 → tomorrow's.
    expect(computeNextRunAt({ interval: 'daily', hour: 6 }, sunday0630).toISOString()).toBe(
      '2026-03-16T06:00:00.000Z',
    );
    // Next Tuesday (day 2) at 09:00.
    expect(
      computeNextRunAt({ interval: 'weekly', dayOfWeek: 2, hour: 9 }, sunday0630).toISOString(),
    ).toBe('2026-03-17T09:00:00.000Z');
  });

  it('the stored next_run_at is exactly the bound instant, independent of when the row was written', async () => {
    const spec: ScheduleSpec = { interval: 'weekly', dayOfWeek: 3, hour: 14 };
    const now = new Date('2026-03-15T06:30:00.000Z');
    const nextRunAt = computeNextRunAt(spec, now); // 2026-03-18T14:00:00.000Z (next Wednesday)
    expect(nextRunAt.toISOString()).toBe('2026-03-18T14:00:00.000Z');

    const created = await tenant.transaction(northstar, (tx) =>
      schedules.create(tx, northstar, {
        templateId: nsTemplate,
        spec,
        nextRunAt,
        enabled: true,
      }),
    );
    expect(created.nextRunAt.getTime()).toBe(nextRunAt.getTime());

    // Observed through the admin pool (its session clock is SYSTEM): the column holds the bound
    // instant, a fixed point in the past relative to this run, not CURRENT_TIMESTAMP.
    const rows = await observe('select next_run_at from automation_schedules where id = ?', [
      created.id,
    ]);
    expect(new Date(rows[0]?.['next_run_at'] as string | Date).getTime()).toBe(nextRunAt.getTime());
    expect(nextRunAt.getTime()).toBeLessThan(Date.now());
  });
});

describe('a condition belongs to exactly one template', () => {
  it('is listed under its own template and no sibling, and reads back carrying that one template_id', async () => {
    // nsCondition was created on nsTemplate. It appears there, and never under nsTemplateB.
    const onA = await tenant.read(northstar, (tx) =>
      conditions.listForTemplate(tx, northstar, nsTemplate),
    );
    expect(onA.map((row) => row.id)).toContain(nsCondition);

    const onB = await tenant.read(northstar, (tx) =>
      conditions.listForTemplate(tx, northstar, nsTemplateB),
    );
    expect(onB.map((row) => row.id)).not.toContain(nsCondition);

    const found = await tenant.read(northstar, (tx) =>
      conditions.findById(tx, northstar, nsCondition),
    );
    expect(found?.templateId).toBe(nsTemplate);

    // Exactly one row carries this id, and it names exactly one template.
    const rows = await observe(
      `select template_id from workflow_conditions where organization_id = ? and id = ?`,
      [world.northstar.organizationId, nsCondition],
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.['template_id'])).toBe(nsTemplate);
  });
});

describe('the Drizzle seam keeps the tenant guard on the automations path', () => {
  it('throws when a query omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { workflowTemplates } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(workflowTemplates);
      }),
    ).rejects.toThrow(/no organization_id predicate/);
    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['workflow_templates']);
  });
});
