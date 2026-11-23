import { authorize, isHandTimeCountMode, isIdleCapHours, timeTrustOf } from '@tmanage/domain';
import type {
  HandTimeCountMode,
  Principal,
  TimeApprovalState,
  TimeTrust,
  TimeTrustPolicy,
} from '@tmanage/domain';
import type { WorkItemTimeLogRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import { requireInternal } from './time-capabilities.js';
import { isWithinLockedPeriod, optionalMinutes } from './time-rules.js';
import type { TimeLogSource } from './time-rules.js';
import {
  TIME_HAND_COUNT_KEY,
  TIME_HAND_ENTRY_KEY,
  TIME_IDLE_CAP_KEY,
  countedFor,
  isMeasured,
  mayDecideTimeEntry,
  optionalReason,
  readTimeTrustPolicy,
  requiredReason,
} from './time-trust-rules.js';
import type { TimeTrustRepository } from './time-trust.repository.js';
import type { TimesheetsRepository } from './timesheets.repository.js';
import { entryLocked, notFound, pathId, record } from './timesheets-rules.js';

/**
 * Time you can trust (owner rule, 2026-11-23): the owner's policy (Admin > Time), the managers'
 * approval queue, corrections of measured time and an entry's history.
 *
 * - **Policy** (`GET`, every internal member; `PATCH`, the company owner only, audited with before
 *   and after). Changing how pending hand time counts rewrites the stored `counted` of every
 *   pending, unlocked hand entry in the same transaction, so no report reads a stale answer.
 * - **Queue** (`project.manage` at the route): pending hand time, corrections and timers the
 *   system stopped at the cap, filtered to the entries the caller may decide
 *   (`mayDecideTimeEntry`: never one's own; an owner/admin any; a project lead their projects).
 * - **Decide**: approve or refuse (with a note) one pending, unlocked entry, under its row lock and a
 *   conditional UPDATE (DA-1). An approved correction makes the measured entry it corrects stop
 *   counting (`superseded_by`); the original stays in the history.
 * - **Correction** (the member, on their own measured entry): a new `source = 'correction'` row
 *   with the right minutes and a reason, pending, never counted until approved. Allowed even when
 *   the owner turned hand time off: it is the way to fix a mistake in timer time.
 * - **History**: the entry, the entry it corrects and its corrections, for the member and for
 *   anyone who may decide on it. The full before/after of every change is in the audit log.
 *
 * Every write records an audit row in the same transaction (DA-11): who, what, before and after.
 */

export interface TimeTrustPolicyView {
  readonly handTimeAllowed: boolean;
  readonly handTimeCountMode: HandTimeCountMode;
  readonly idleCapHours: number;
  /** AR-9: may the caller change it (the company owner)? */
  readonly mayChange: boolean;
}

export interface TimeTrustEntryView {
  readonly id: string;
  readonly membershipId: string;
  readonly workItemId: string | null;
  readonly workItemTitle: string | null;
  readonly projectId: string | null;
  readonly spentOn: string;
  readonly minutes: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly billable: boolean;
  readonly source: TimeLogSource;
  /** `measured` (timer, automatic) or `hand` (typed in, correction). */
  readonly trust: TimeTrust;
  readonly approvalState: TimeApprovalState;
  /** Counts in totals, reports, invoices, payroll exports and the portal. */
  readonly counted: boolean;
  readonly needsReview: boolean;
  readonly reason: string | null;
  readonly correctsEntryId: string | null;
  readonly supersededBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  /** Changed after it was created (an "Edited" badge). */
  readonly edited: boolean;
  readonly createdAt: string;
  /** AR-9: may the caller approve or refuse it now? */
  readonly mayDecide: boolean;
}

export interface TimeApprovalQueueView {
  readonly entries: readonly TimeTrustEntryView[];
  readonly pendingMinutes: number;
}

export interface TimeEntryHistoryView {
  readonly entry: TimeTrustEntryView;
  /** On a correction: the measured entry it corrects. */
  readonly original: TimeTrustEntryView | null;
  readonly corrections: readonly TimeTrustEntryView[];
}

export interface TimeTrustServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<
    TimeTrustRepository,
    'findEntry' | 'listPending' | 'correctionsOf' | 'decide' | 'supersede' | 'recountPendingHand'
  >;
  readonly sheets: Pick<TimesheetsRepository, 'titles' | 'openLocks'>;
  readonly timeLogs: Pick<WorkTimeLogsRepository, 'create'>;
  readonly settings: Pick<OrgSettingsRepository, 'findByKey' | 'upsert' | 'resolveOrganization'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const ORG_RESOURCE = (context: TenantContext) => ({
  organizationId: context.organizationId,
  projectId: null,
  audience: 'internal' as const,
  lifecycle: 'active' as const,
});

const decided = (): ApiError =>
  new ApiError(409, 'conflict', 'This time was already decided on.', [
    { field: 'approvalState', message: 'not_pending' },
  ]);

export class TimeTrustService {
  private readonly now: () => Date;

  constructor(private readonly options: TimeTrustServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async policy(context: TenantContext, principal: Principal): Promise<TimeTrustPolicyView> {
    requireInternal(principal);
    return this.options.database.read(context, async (r) =>
      policyView(await readTimeTrustPolicy(r, context, this.options.settings), principal),
    );
  }

  /** Admin > Time. The company owner alone; audited with every field's before and after. */
  async setPolicy(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<TimeTrustPolicyView> {
    requireInternal(principal);
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: ORG_RESOURCE(context),
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `time_trust:${verdict.code}`,
      );
    }
    if (principal.kind !== 'internal' || principal.role !== 'owner') {
      throw new ApiError(
        403,
        'forbidden',
        'Only the company owner can change this setting.',
        undefined,
        'time_trust.write:not_owner',
      );
    }
    const input = parsePolicyPatch(body);
    const { settings, repository } = this.options;
    return this.options.database.transaction(context, async (tx) => {
      if (!(await settings.resolveOrganization(tx, context))) throw notFound();
      const before = await readTimeTrustPolicy(tx, context, settings);
      const after: TimeTrustPolicy = { ...before, ...input };
      const writes: [
        typeof TIME_HAND_ENTRY_KEY | typeof TIME_HAND_COUNT_KEY | typeof TIME_IDLE_CAP_KEY,
        string,
      ][] = [
        [TIME_HAND_ENTRY_KEY, String(after.handTimeAllowed)],
        [TIME_HAND_COUNT_KEY, after.handTimeCountMode],
        [TIME_IDLE_CAP_KEY, String(after.idleCapHours)],
      ];
      for (const [key, value] of writes) {
        await settings.upsert(tx, context, { key, value, updatedBy: principal.userId });
      }
      const recounted =
        after.handTimeCountMode === before.handTimeCountMode
          ? 0
          : await repository.recountPendingHand(
              tx,
              context,
              after.handTimeCountMode === 'at_once_flagged',
            );
      await this.options.audit.record(tx, context, {
        action: 'organization.time_trust_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { recounted_entries: recounted },
        changes: [
          {
            field: 'time_hand_entry',
            before: String(before.handTimeAllowed),
            after: String(after.handTimeAllowed),
          },
          {
            field: 'time_hand_count',
            before: before.handTimeCountMode,
            after: after.handTimeCountMode,
          },
          {
            field: 'time_idle_cap_hours',
            before: String(before.idleCapHours),
            after: String(after.idleCapHours),
          },
        ],
      });
      return policyView(after, principal);
    });
  }

  /** The entries waiting for the caller's decision. */
  async queue(context: TenantContext, principal: Principal): Promise<TimeApprovalQueueView> {
    requireInternal(principal);
    return this.options.database.read(context, async (r) => {
      const rows = (await this.options.repository.listPending(r, context)).filter((row) =>
        mayDecideTimeEntry(principal, context, row),
      );
      const views = await this.views(r, context, principal, rows);
      return { entries: views, pendingMinutes: rows.reduce((sum, row) => sum + row.minutes, 0) };
    });
  }

  /** Approve (`approve = true`) or refuse one pending entry. A refusal needs a note. */
  async decide(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
    approve: boolean,
  ): Promise<TimeTrustEntryView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const note = approve
      ? optionalReason(record(body)['note'], 'note')
      : requiredReason(record(body)['note'], 'note');
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const row = await repo.findEntry(tx, context, id, true);
      // Not decidable by this caller = the same 404 an absent id gives (no enumeration).
      if (row === null || !mayDecideTimeEntry(principal, context, row)) throw notFound();
      if (row.approvalState !== 'pending') throw decided();
      if (await this.inClosedPeriod(tx, context, row)) throw entryLocked();
      const policy = await readTimeTrustPolicy(tx, context, this.options.settings);
      const state: 'approved' | 'rejected' = approve ? 'approved' : 'rejected';
      const counted = countedFor(row, state, policy.handTimeCountMode);
      const before = { approvalState: row.approvalState, counted: row.counted };
      const changed = await repo.decide(tx, context, row.id, {
        approvalState: state,
        counted,
        decidedBy: context.membershipId,
        decidedAt: at,
        decisionNote: note,
      });
      if (changed === 0) throw decided();
      let superseded = false;
      if (approve && row.source === 'correction' && row.correctsEntryId !== null) {
        superseded =
          (await repo.supersede(
            tx,
            context,
            row.correctsEntryId,
            row.id,
            context.membershipId,
            at,
          )) > 0;
        if (!superseded) throw entryLocked();
      }
      await this.options.audit.record(tx, context, {
        action: approve ? 'time_log.approved' : 'time_log.rejected',
        objectId: row.id,
        result: 'allowed',
        actorUserId: context.userId,
        metadata: {
          source: row.source,
          member_membership_id: row.loggedBy,
          minutes: row.minutes,
          ...(row.correctsEntryId === null ? {} : { corrects_entry_id: row.correctsEntryId }),
          superseded,
        },
        changes: [
          { field: 'approval_state', before: before.approvalState, after: state },
          { field: 'counted', before: String(before.counted), after: String(counted) },
        ],
      });
      const fresh = await repo.findEntry(tx, context, row.id);
      if (fresh === null) throw notFound();
      return (await this.views(tx, context, principal, [fresh]))[0]!;
    });
  }

  /**
   * Ask for a correction of one's own measured entry: the right minutes and a reason. The original
   * keeps counting until a manager approves the correction.
   */
  async requestCorrection(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimeTrustEntryView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const input = record(body);
    const minutes = optionalMinutes(input['minutes']);
    if (minutes === null) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'minutes', message: 'must be a whole number of minutes from 1 to 1440' },
      ]);
    }
    const reason = requiredReason(input['reason']);
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const row = await repo.findEntry(tx, context, id, true);
      if (row === null || row.loggedBy !== context.membershipId) throw notFound();
      if (!isMeasured(row)) {
        throw new ApiError(
          409,
          'conflict',
          'Only timer time is corrected this way. Change time added by hand directly; it goes back for approval.',
          [{ field: 'source', message: 'not_measured' }],
        );
      }
      if (row.supersededBy !== null) {
        throw new ApiError(409, 'conflict', 'This entry was already corrected.', [
          { field: 'supersededBy', message: 'already_corrected' },
        ]);
      }
      if (row.lockedAt !== null || (await this.inClosedPeriod(tx, context, row)))
        throw entryLocked();
      if (minutes === row.minutes) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'minutes', message: 'must differ from the measured minutes' },
        ]);
      }
      const open = (await repo.correctionsOf(tx, context, row.id)).some(
        (c) => c.approvalState === 'pending',
      );
      if (open) {
        throw new ApiError(409, 'conflict', 'A correction of this entry is already waiting.', [
          { field: 'correction', message: 'correction_pending' },
        ]);
      }
      const correction = await this.options.timeLogs.create(tx, context, {
        workItemId: row.workItemId,
        projectId: row.projectId,
        loggedBy: row.loggedBy,
        minutes,
        spentOn: row.spentOn,
        note: row.note,
        billable: row.billable,
        source: 'correction',
        approvalState: 'pending',
        counted: false,
        reason,
        correctsEntryId: row.id,
      });
      await this.options.audit.record(tx, context, {
        action: 'time_log.correction_requested',
        objectId: correction.id,
        result: 'allowed',
        actorUserId: context.userId,
        metadata: { corrects_entry_id: row.id, source: row.source },
        changes: [{ field: 'minutes', before: String(row.minutes), after: String(minutes) }],
      });
      return (await this.views(tx, context, principal, [correction]))[0]!;
    });
  }

  /** One entry with what it corrects and its corrections. Own entries, or one the caller may decide. */
  async history(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
  ): Promise<TimeEntryHistoryView> {
    requireInternal(principal);
    const id = pathId(idRaw);
    const repo = this.options.repository;
    return this.options.database.read(context, async (r) => {
      const row = await repo.findEntry(r, context, id);
      if (row === null) throw notFound();
      const own = row.loggedBy === context.membershipId;
      if (!own && !mayDecideTimeEntry(principal, context, row)) throw notFound();
      const original =
        row.correctsEntryId === null ? null : await repo.findEntry(r, context, row.correctsEntryId);
      const corrections = await repo.correctionsOf(r, context, row.id);
      const all = await this.views(r, context, principal, [
        row,
        ...(original === null ? [] : [original]),
        ...corrections,
      ]);
      return {
        entry: all[0]!,
        original: original === null ? null : all[1]!,
        corrections: all.slice(original === null ? 1 : 2),
      };
    });
  }

  private async inClosedPeriod(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: WorkItemTimeLogRow,
  ): Promise<boolean> {
    if (row.lockedAt !== null) return true;
    const locks = await this.options.sheets.openLocks(runner, context, {
      periodStart: row.spentOn,
      periodEnd: row.spentOn,
    });
    return isWithinLockedPeriod(row.spentOn, locks);
  }

  private async views(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    rows: readonly WorkItemTimeLogRow[],
  ): Promise<TimeTrustEntryView[]> {
    const titles = await this.options.sheets.titles(
      runner,
      context,
      rows.flatMap((row) => (row.workItemId === null ? [] : [row.workItemId])),
    );
    return rows.map((row) =>
      trustEntryView(row, titles, mayDecideTimeEntry(principal, context, row)),
    );
  }
}

function policyView(policy: TimeTrustPolicy, principal: Principal): TimeTrustPolicyView {
  return {
    handTimeAllowed: policy.handTimeAllowed,
    handTimeCountMode: policy.handTimeCountMode,
    idleCapHours: policy.idleCapHours,
    mayChange: principal.kind === 'internal' && principal.role === 'owner',
  };
}

function parsePolicyPatch(body: unknown): Partial<TimeTrustPolicy> {
  const input = record(body);
  const out: {
    handTimeAllowed?: boolean;
    handTimeCountMode?: HandTimeCountMode;
    idleCapHours?: number;
  } = {};
  const fail = (field: string, message: string) =>
    new ApiError(400, 'validation_failed', 'The request body is invalid', [{ field, message }]);
  if (input['handTimeAllowed'] !== undefined) {
    if (typeof input['handTimeAllowed'] !== 'boolean')
      throw fail('handTimeAllowed', 'must be true or false');
    out.handTimeAllowed = input['handTimeAllowed'];
  }
  if (input['handTimeCountMode'] !== undefined) {
    if (!isHandTimeCountMode(input['handTimeCountMode'])) {
      throw fail('handTimeCountMode', 'must be after_approval or at_once_flagged');
    }
    out.handTimeCountMode = input['handTimeCountMode'];
  }
  if (input['idleCapHours'] !== undefined) {
    if (!isIdleCapHours(input['idleCapHours']))
      throw fail('idleCapHours', 'must be 4 to 24 whole hours');
    out.idleCapHours = input['idleCapHours'];
  }
  if (Object.keys(out).length === 0) {
    throw fail(
      'handTimeAllowed',
      'send at least one of handTimeAllowed, handTimeCountMode, idleCapHours',
    );
  }
  return out;
}

/** One entry as every time-trust surface shows it (the labels: measured, by hand, waiting, edited). */
export function trustEntryView(
  row: WorkItemTimeLogRow,
  titles: ReadonlyMap<string, string>,
  mayDecide: boolean,
): TimeTrustEntryView {
  return {
    id: row.id,
    membershipId: row.loggedBy,
    workItemId: row.workItemId,
    workItemTitle: row.workItemId === null ? null : (titles.get(row.workItemId) ?? null),
    projectId: row.projectId,
    spentOn: row.spentOn,
    minutes: row.minutes,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    billable: row.billable,
    source: row.source,
    trust: timeTrustOf(row.source),
    approvalState: row.approvalState,
    counted: row.counted,
    needsReview: row.needsReview,
    reason: row.reason ?? null,
    correctsEntryId: row.correctsEntryId ?? null,
    supersededBy: row.supersededBy ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote ?? null,
    edited: row.updatedAt !== null,
    createdAt: row.createdAt.toISOString(),
    mayDecide: mayDecide && row.approvalState === 'pending',
  };
}
