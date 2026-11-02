import {
  AUDIENCES,
  authorize,
  localDateOf,
  minutesOfClock,
  occurrencesOf,
  uuidv7,
  zonedInstant,
} from '@tmanage/domain';
import type { AuditAction, AuditMetadata, Occurrence, WorkingCalendar } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRecurrenceRow, WorkItemRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import type { CreateWorkItemInput, WorkItemsRepository } from './work-items.repository.js';
import type { WorkItemsService } from './work-items.service.js';
import { WorkItemRecurrenceRepository } from './item-recurrence.repository.js';
import { holidayPolicyOf, ruleOfRow } from './item-recurrence.service.js';
import type { RecurrenceCalendarSource } from './item-recurrence.service.js';
import {
  RECURRENCE_SPAWNER_SCAN_REASON,
  RecurrenceSpawnerRepository,
} from './recurrence-spawner.repository.js';
import type { OwnerIdentity } from './recurrence-spawner.repository.js';

/**
 * 53-09 — the in-process recurrence spawner (a named service entry point, doc 25 §10, reason code
 * `recurrence_spawner`). Driven by `apiSweepJobs` in `apps/server/scheduled-sweeps.mjs` on the
 * minute tick; a pass returns at once unless {@link RECURRENCE_SPAWN_INTERVAL_MS} passed since the
 * last one. No route reaches it, so it never runs under MCP.
 *
 * For each active, materialised rule (organizations found by one ids-only cross-org read, then every
 * statement under a service context naming the organization):
 *
 * 1. The owner's principal is rebuilt from stored facts and must still hold `work.create` in the
 *    seed's project; if not, the rule is paused, the owner gets an inbox notice and the pause is
 *    audited (fail closed).
 * 2. Due occurrences: `on_schedule` — every occurrence dated up to today + `spawn_ahead_days`;
 *    `after_done` — the next one, once the last spawned item (or the seed) is done.
 * 3. Each occurrence's instance row is INSERTed FIRST; a duplicate key means another pass already
 *    took it (restart safety). Then the item is created through `WorkItemsService.create` as the
 *    owner, and the claim is completed with the item, the rule's `last_occurrence_key` advanced and
 *    `recurrence.spawned` audited. A failed create gives the claim back, so the next pass retries.
 *
 * Caps: 500 spawns per organization per rolling day (admins get one notice a day); a rule with more
 * than 50 occurrences due at once (a long pause) skips the backlog, spawns only the next occurrence
 * and tells the owner.
 */

export const RECURRENCE_SPAWNER = Symbol.for('tmanage.RecurrenceSpawner');
export const RECURRENCE_SPAWN_INTERVAL_MS = 15 * 60_000;
export const RECURRENCE_DAILY_CAP = 500;
export const RECURRENCE_BURST_CAP = 50;
export const RECURRENCE_ENTRY_POINT = 'recurrence_spawner';
const DAY_MS = 86_400_000;
const MAX_TITLE = 300;

export interface RecurrenceSpawnReport {
  /** False when the pass returned at once (less than 15 minutes since the last). */
  readonly ran: boolean;
  readonly organizations: number;
  readonly rules: number;
  readonly spawned: number;
  /** Occurrences another pass had already claimed. */
  readonly duplicates: number;
  readonly paused: number;
  readonly ended: number;
  readonly capped: number;
  readonly failed: number;
}

type Tally = { -readonly [K in keyof RecurrenceSpawnReport]: RecurrenceSpawnReport[K] };

export interface RecurrenceSpawnerDeps {
  readonly database: TenantDatabase;
  readonly workItems: Pick<WorkItemsService, 'create'>;
  readonly workItemsRepository: Pick<WorkItemsRepository, 'findById'>;
  readonly calendars: RecurrenceCalendarSource;
  readonly audit?: AuditService;
  readonly repository?: RecurrenceSpawnerRepository;
  readonly recurrence?: WorkItemRecurrenceRepository;
  readonly notifications?: Pick<NotificationsRepository, 'insertForRecipient'>;
  readonly onFailure?: (recurrenceId: string, error: unknown) => void;
}

/** The scheduled day + `days`, as an ISO date. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export class RecurrenceSpawner {
  private lastRunAt: number | null = null;
  private readonly repository: RecurrenceSpawnerRepository;
  private readonly recurrence: WorkItemRecurrenceRepository;
  private readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>;

  constructor(private readonly deps: RecurrenceSpawnerDeps) {
    this.repository = deps.repository ?? new RecurrenceSpawnerRepository();
    this.recurrence = deps.recurrence ?? new WorkItemRecurrenceRepository();
    this.notifications = deps.notifications ?? new NotificationsRepository();
  }

  /** One pass, at most every 15 minutes. Idempotent: a second pass finds every occurrence claimed. */
  async sweep(now: Date = new Date()): Promise<RecurrenceSpawnReport> {
    const tally: Tally = {
      ran: false,
      organizations: 0,
      rules: 0,
      spawned: 0,
      duplicates: 0,
      paused: 0,
      ended: 0,
      capped: 0,
      failed: 0,
    };
    if (this.lastRunAt !== null && now.getTime() - this.lastRunAt < RECURRENCE_SPAWN_INTERVAL_MS) {
      return tally;
    }
    this.lastRunAt = now.getTime();
    tally.ran = true;
    const correlationId = uuidv7();
    const organizations = await this.deps.database.bootstrapRead(
      {
        correlationId,
        reason: RECURRENCE_SPAWNER_SCAN_REASON,
        tables: ['work_item_recurrence', 'organizations'],
      },
      (db) => this.repository.organizationsWithActiveRules(db),
    );
    tally.organizations = organizations.length;
    for (const organizationId of organizations) {
      const context = createServiceContext({
        organizationId,
        correlationId,
        policyVersion: RECURRENCE_ENTRY_POINT,
      });
      await this.sweepOrganization(context, now, tally);
    }
    return tally;
  }

  private async sweepOrganization(context: TenantContext, now: Date, tally: Tally): Promise<void> {
    const { rules, calendar, spawnedToday } = await this.deps.database.read(
      context,
      async (runner) => ({
        rules: await this.repository.activeRules(runner, context),
        calendar: await this.deps.calendars.calendarOf(runner, context),
        spawnedToday: await this.repository.countSpawnedSince(
          runner,
          context,
          new Date(now.getTime() - DAY_MS),
        ),
      }),
    );
    let budget = RECURRENCE_DAILY_CAP - spawnedToday;
    for (const row of rules) {
      if (budget <= 0) {
        tally.capped += 1;
        await this.notifyAdmins(context, now, calendar);
        return;
      }
      tally.rules += 1;
      try {
        budget -= await this.sweepRule(context, row, calendar, now, budget, tally);
      } catch (error) {
        tally.failed += 1;
        this.deps.onFailure?.(row.id, error);
      }
    }
  }

  /** Returns how many items this rule spawned. */
  private async sweepRule(
    context: TenantContext,
    row: WorkItemRecurrenceRow,
    calendar: WorkingCalendar,
    now: Date,
    budget: number,
    tally: Tally,
  ): Promise<number> {
    const { seed, owner, last } = await this.deps.database.read(context, async (runner) => ({
      seed: await this.deps.workItemsRepository.findById(runner, context, row.workItemId),
      owner: row.ownerUserId
        ? await this.repository.principalOfUser(runner, context, row.ownerUserId)
        : null,
      last: await this.repository.lastCreatedInstance(runner, context, row.id),
    }));
    if (!seed || seed.deletedAt !== null) {
      await this.setStatus(context, row, 'ended', { cause: 'seed_removed' });
      tally.ended += 1;
      return 0;
    }
    if (!owner || !this.mayCreate(owner, seed)) {
      await this.pauseForOwner(context, row, 'owner_lost_work_create');
      tally.paused += 1;
      return 0;
    }
    const zone = row.timeZone ?? calendar.timeZone;
    const rule = ruleOfRow(row, zone);
    if (!rule) return 0;
    const policy = holidayPolicyOf(row);
    const today = localDateOf(now, zone);
    const lower = row.lastOccurrenceKey ?? rule.start;

    let due: readonly Occurrence[];
    let burst = false;
    if (row.spawnMode === 'after_done') {
      const lastItem = last?.workItemId
        ? await this.deps.database.read(context, (runner) =>
            this.deps.workItemsRepository.findById(runner, context, last.workItemId as string),
          )
        : seed;
      const finished = !lastItem || lastItem.deletedAt !== null || lastItem.completedAt !== null;
      due = finished ? occurrencesOf(rule, lower, 1, calendar, policy) : [];
    } else {
      const horizon = addDays(today, row.spawnAheadDays ?? 1);
      due = occurrencesOf(rule, lower, RECURRENCE_BURST_CAP + 1, calendar, policy).filter(
        (o) => o.date <= horizon,
      );
      if (due.length > RECURRENCE_BURST_CAP) {
        // A long pause: skip the backlog, spawn only the next occurrence from yesterday on.
        burst = true;
        due = occurrencesOf(rule, addDays(today, -1), 1, calendar, policy).filter(
          (o) => o.date <= horizon,
        );
      }
    }

    let spawned = 0;
    let previous = last?.workItemId ?? seed.id;
    for (const occurrence of due) {
      if (spawned >= budget) break;
      const outcome = await this.spawnOne(
        context,
        row,
        seed,
        owner,
        occurrence,
        previous,
        calendar,
      );
      if (outcome === 'paused') {
        tally.paused += 1;
        break;
      }
      if (outcome === 'duplicate') {
        tally.duplicates += 1;
        continue;
      }
      spawned += 1;
      tally.spawned += 1;
      previous = outcome;
    }
    if (burst) await this.notifyOwner(context, row, 'recurrence.burst_capped', today);
    return spawned;
  }

  /** The new item's id, or what stopped it. */
  private async spawnOne(
    context: TenantContext,
    row: WorkItemRecurrenceRow,
    seed: WorkItemRow,
    owner: OwnerIdentity,
    occurrence: Occurrence,
    previousWorkItemId: string,
    calendar: WorkingCalendar,
  ): Promise<string | 'duplicate' | 'paused'> {
    // 1. Claim the occurrence FIRST: the unique key is the restart safety.
    const claimId = await this.deps.database.transaction(context, (tx) =>
      this.recurrence.insertInstance(tx, context, {
        recurrenceId: row.id,
        occurrenceKey: occurrence.key,
        status: 'created',
        previousWorkItemId,
      }),
    );
    if (claimId === null) return 'duplicate';

    // 2. Create the item as the owner, through the ordinary create path (its own checks and audit).
    let createdId: string;
    try {
      const zone = row.timeZone ?? calendar.timeZone;
      const dueMinutes = minutesOfClock(calendar.dayEnd) ?? 17 * 60;
      const created = await this.deps.workItems.create(
        owner.context,
        owner.principal,
        createInputOf(row, seed, zonedInstant(occurrence.date, dueMinutes, zone)),
      );
      createdId = created.id;
    } catch (error) {
      await this.deps.database.transaction(context, (tx) =>
        this.repository.releaseInstance(tx, context, claimId),
      );
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        await this.pauseForOwner(context, row, 'owner_create_refused');
        return 'paused';
      }
      throw error;
    }

    // 3. Complete the claim, advance the series, and record the service action.
    await this.deps.database.transaction(context, async (tx) => {
      await this.repository.completeInstance(tx, context, claimId, createdId);
      await this.repository.advanceLastOccurrence(tx, context, row.id, occurrence.key);
      await this.deps.audit?.record(tx, context, {
        action: 'recurrence.spawned',
        objectId: createdId,
        result: 'allowed',
        actorUserId: null,
        metadata: {
          entry_point: RECURRENCE_ENTRY_POINT,
          occurrence_key: occurrence.key,
          work_item_id: createdId,
          series_work_item_id: seed.id,
          recurrence_id: row.id,
        },
      });
    });
    return createdId;
  }

  private mayCreate(owner: OwnerIdentity, seed: WorkItemRow): boolean {
    return authorize({
      principal: owner.principal,
      capability: 'work.create',
      resource: {
        organizationId: seed.organizationId,
        projectId: seed.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  private async pauseForOwner(
    context: TenantContext,
    row: WorkItemRecurrenceRow,
    cause: string,
  ): Promise<void> {
    await this.setStatus(context, row, 'paused', { cause });
    await this.notifyOwner(context, row, 'recurrence.paused', row.id);
  }

  private async setStatus(
    context: TenantContext,
    row: WorkItemRecurrenceRow,
    status: 'paused' | 'ended',
    metadata: AuditMetadata,
  ): Promise<void> {
    const action: AuditAction = status === 'paused' ? 'recurrence.paused' : 'recurrence.ended';
    await this.deps.database.transaction(context, async (tx) => {
      await this.recurrence.setStatus(tx, context, row.id, status);
      await this.deps.audit?.record(tx, context, {
        action,
        objectId: row.workItemId,
        result: 'allowed',
        actorUserId: null,
        metadata: { entry_point: RECURRENCE_ENTRY_POINT, ...metadata },
      });
    });
  }

  private async notifyOwner(
    context: TenantContext,
    row: WorkItemRecurrenceRow,
    type: string,
    dedupe: string,
  ): Promise<void> {
    const recipientUserId = row.ownerUserId;
    if (!recipientUserId) return;
    await this.deps.database.transaction(context, (tx) =>
      this.notifications.insertForRecipient(tx, context, {
        recipientUserId,
        type,
        objectType: 'work_item',
        objectId: row.workItemId,
        dedupeKey: `${type}:${row.id}:${dedupe}`,
      }),
    );
  }

  private async notifyAdmins(context: TenantContext, now: Date, calendar: WorkingCalendar) {
    const day = localDateOf(now, calendar.timeZone);
    await this.deps.database.transaction(context, async (tx) => {
      for (const recipientUserId of await this.repository.adminUserIds(tx, context)) {
        await this.notifications.insertForRecipient(tx, context, {
          recipientUserId,
          type: 'recurrence.cap_reached',
          objectType: 'organization',
          objectId: context.organizationId,
          dedupeKey: `recurrence.cap_reached:${context.organizationId}:${day}`,
        });
      }
    });
  }
}

/**
 * The create input from the rule's template snapshot, re-validated against the create schema's
 * bounds (a hand-edited or stale template falls back to the seed's own fields).
 */
export function createInputOf(
  row: WorkItemRecurrenceRow,
  seed: WorkItemRow,
  dueAt: Date,
): CreateWorkItemInput {
  const template = (row.templateJson ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null;
  const audience = template['audience'];
  return {
    projectId: seed.projectId,
    title: text(template['title'], MAX_TITLE) ?? seed.title,
    description:
      template['description'] === null ? null : (text(template['description'], 20_000) ?? null),
    type: text(template['type'], 32) ?? seed.type,
    ownerUserId: text(template['ownerUserId'], 36) ?? seed.ownerUserId,
    audience: (AUDIENCES as readonly unknown[]).includes(audience)
      ? (audience as WorkItemRow['audience'])
      : seed.audience,
    dueAt,
  };
}

/** The one line a pass prints. */
export function describeRecurrenceSweep(report: RecurrenceSpawnReport): string {
  if (!report.ran) return 'recurrence spawner: not due';
  return (
    `recurrence spawner: spawned ${report.spawned}, duplicates ${report.duplicates}, ` +
    `paused ${report.paused}, ended ${report.ended}, capped ${report.capped}, ` +
    `failed ${report.failed} (${report.rules} rule(s), ${report.organizations} organization(s))`
  );
}
