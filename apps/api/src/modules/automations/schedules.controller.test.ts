import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { AutomationSchedulesService } from './schedules.controller.js';
import type { AutomationSchedulesRepository } from './schedules.repository.js';
import type { CreateAutomationScheduleInput } from './schedules.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AutomationScheduleRow } from '../../common/database/schema.js';
import { computeNextRunAt, parseScheduleSpec } from './next-run.js';

/**
 * Automations scheduled triggers (x167) service proofs, database-free over the module's fakes. The
 * migration and the tenant-scoped SQL round-trip are proven separately by the chain's DB suite; here
 * the subject is the service's own security and validation logic — the Known-trap resolve-before-
 * authorize order (a cross-tenant/unknown template is a 404 with no write), the `org.manage` refusal
 * (403), the bounded-spec refusal (400 with no write), and that a valid spec writes a row with the
 * deterministic `nextRunAt`. `next-run.ts`'s pure computation is proven directly at the end.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const TEMPLATE = 'template-0000-0000-0000-0000-000000000001';
const OTHER_TEMPLATE = 'template-0000-0000-0000-0000-0000000000ff';

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** A fixed instant so `computeNextRunAt` is deterministic in these proofs. */
const NOW = new Date('2026-09-27T09:30:00.000Z');

function principal(role: Principal['role'], hasOrgWideScope: boolean): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope,
  };
}

/** An owner has `org.manage`; an `org_admin` does not (12-PERMISSION-MATRIX §2). */
const OWNER = principal('owner', true);
const NO_MANAGE = principal('org_admin', true);

/**
 * A service over an in-memory store. `knownTemplateIds` stands in for the tenant-scoped
 * `workflow_templates` existence check: any other id resolves to "not found" (unknown or
 * cross-tenant).
 */
function serviceWith(knownTemplateIds: readonly string[] = [TEMPLATE]): {
  service: AutomationSchedulesService;
  store: AutomationScheduleRow[];
} {
  const store: AutomationScheduleRow[] = [];
  let seq = 0;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    templateExists: async (_runner: unknown, _ctx: unknown, templateId: string) =>
      knownTemplateIds.includes(templateId),
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime() || a.id.localeCompare(b.id)),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ctx.organizationId) ?? null,
    create: async (_runner: unknown, ctx: TenantContext, input: CreateAutomationScheduleInput) => {
      const row = {
        id: `schedule-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        templateId: input.templateId,
        specJson: input.spec,
        nextRunAt: input.nextRunAt,
        enabled: input.enabled,
        createdAt: new Date(),
      } as unknown as AutomationScheduleRow;
      store.push(row);
      return row;
    },
  } as unknown as AutomationSchedulesRepository;
  return { service: new AutomationSchedulesService(database, repository), store };
}

describe('AutomationSchedulesService', () => {
  it('records a schedule and computes the deterministic nextRunAt for a bound now', async () => {
    const { service, store } = serviceWith();
    const created = await service.schedule(
      context,
      OWNER,
      TEMPLATE,
      { interval: 'daily', hour: 8 },
      { now: NOW },
    );

    expect(created.templateId).toBe(TEMPLATE);
    expect(created.spec).toEqual({ interval: 'daily', hour: 8 });
    expect(created.enabled).toBe(true);
    // 08:00 has already passed at 09:30, so the next daily fire is 08:00 tomorrow (UTC).
    expect(created.nextRunAt).toBe('2026-09-28T08:00:00.000Z');
    expect(store).toHaveLength(1);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);
  });

  it('records a disabled schedule when enabled is false at creation', async () => {
    const { service } = serviceWith();
    const created = await service.schedule(
      context,
      OWNER,
      TEMPLATE,
      { interval: 'hourly' },
      {
        now: NOW,
        enabled: false,
      },
    );
    expect(created.enabled).toBe(false);
  });

  it('lists a tenant’s schedules soonest-due first', async () => {
    const { service } = serviceWith();
    await service.schedule(context, OWNER, TEMPLATE, { interval: 'daily', hour: 8 }, { now: NOW });
    await service.schedule(context, OWNER, TEMPLATE, { interval: 'hourly' }, { now: NOW });

    const listed = await service.list(context, OWNER);
    // hourly fires at 10:00 today, before the daily's 08:00 tomorrow.
    expect(listed.map((s) => s.nextRunAt)).toEqual([
      '2026-09-27T10:00:00.000Z',
      '2026-09-28T08:00:00.000Z',
    ]);
  });

  it('refuses an unknown or cross-tenant template with a 404 and no write (before authorize)', async () => {
    const { service, store } = serviceWith();
    // OWNER would pass the authorize; the 404 must still win because the template does not resolve.
    await expect(
      service.schedule(context, OWNER, OTHER_TEMPLATE, { interval: 'hourly' }, { now: NOW }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(0);
  });

  it('refuses a caller without org.manage with a 403 and no write', async () => {
    const { service, store } = serviceWith();
    await expect(
      service.schedule(context, NO_MANAGE, TEMPLATE, { interval: 'hourly' }, { now: NOW }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
    await expect(service.list(context, NO_MANAGE)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an off-enum interval with a 400 and no write', async () => {
    const { service, store } = serviceWith();
    await expect(
      service.schedule(context, OWNER, TEMPLATE, { interval: 'yearly' }, { now: NOW }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('refuses an out-of-range hour or dayOfWeek with a 400 and no write', async () => {
    const { service, store } = serviceWith();
    await expect(
      service.schedule(context, OWNER, TEMPLATE, { interval: 'daily', hour: 24 }, { now: NOW }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      service.schedule(
        context,
        OWNER,
        TEMPLATE,
        { interval: 'weekly', hour: 8, dayOfWeek: 7 },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });
});

describe('parseScheduleSpec', () => {
  it('accepts the three intervals and drops unused fields', () => {
    expect(parseScheduleSpec({ interval: 'hourly', hour: 5 })).toEqual({
      ok: true,
      spec: { interval: 'hourly' },
    });
    expect(parseScheduleSpec({ interval: 'daily', hour: 5 })).toEqual({
      ok: true,
      spec: { interval: 'daily', hour: 5 },
    });
    expect(parseScheduleSpec({ interval: 'weekly', hour: 5, dayOfWeek: 3 })).toEqual({
      ok: true,
      spec: { interval: 'weekly', hour: 5, dayOfWeek: 3 },
    });
  });

  it('rejects an off-enum interval and a missing/out-of-range hour or day', () => {
    expect(parseScheduleSpec({ interval: 'yearly' }).ok).toBe(false);
    expect(parseScheduleSpec({ interval: 'daily' }).ok).toBe(false);
    expect(parseScheduleSpec({ interval: 'daily', hour: -1 }).ok).toBe(false);
    expect(parseScheduleSpec({ interval: 'weekly', hour: 8 }).ok).toBe(false);
    expect(parseScheduleSpec({ interval: 'weekly', hour: 8, dayOfWeek: 9 }).ok).toBe(false);
  });
});

describe('computeNextRunAt', () => {
  const now = new Date('2026-09-27T09:30:00.000Z'); // a Sunday

  it('hourly returns the next top of the hour', () => {
    expect(computeNextRunAt({ interval: 'hourly' }, now).toISOString()).toBe(
      '2026-09-27T10:00:00.000Z',
    );
  });

  it('daily returns today’s hour if ahead, else tomorrow’s', () => {
    expect(computeNextRunAt({ interval: 'daily', hour: 14 }, now).toISOString()).toBe(
      '2026-09-27T14:00:00.000Z',
    );
    expect(computeNextRunAt({ interval: 'daily', hour: 8 }, now).toISOString()).toBe(
      '2026-09-28T08:00:00.000Z',
    );
  });

  it('weekly returns this week’s day/hour if ahead, else next week’s', () => {
    // now is Sunday (dayOfWeek 0). Wednesday (3) at 12:00 is later this week.
    expect(
      computeNextRunAt({ interval: 'weekly', hour: 12, dayOfWeek: 3 }, now).toISOString(),
    ).toBe('2026-09-30T12:00:00.000Z');
    // Sunday 08:00 has passed today, so it rolls to next Sunday.
    expect(computeNextRunAt({ interval: 'weekly', hour: 8, dayOfWeek: 0 }, now).toISOString()).toBe(
      '2026-10-04T08:00:00.000Z',
    );
  });
});
