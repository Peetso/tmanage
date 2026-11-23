import {
  DEFAULT_TIME_TRUST_POLICY,
  HAND_TIME_REFUSAL_MESSAGES,
  MEASURED_EDIT_REFUSAL,
  TIME_REASON_MAX,
  TIME_REASON_MIN,
  authorize,
  entryCounts,
  handTimeRefusal,
  isHandTimeCountMode,
  isIdleCapHours,
  timeTrustOf,
} from '@tmanage/domain';
import type {
  HandTimeCountMode,
  Principal,
  TimeApprovalState,
  TimeTrustPolicy,
} from '@tmanage/domain';
import type { WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { TIME_MANAGE_ANY } from './time-capabilities.js';

/**
 * Time you can trust (owner rule, 2026-11-23) — the API half of `@tmanage/domain` `time/trust.ts`:
 * where the owner's policy is stored, how a request's reason is read, the refusals in the owner's
 * words, and who may decide on an entry. Pure except {@link readTimeTrustPolicy}, which reads the
 * three `org_settings` keys in the caller's transaction.
 *
 * Every write path that can put minutes into `work_item_time_logs` calls these (the map is in
 * `work/pass-2026-11-23/TIME-TRUST-REPORT.md`): the work item's "Log time", the timesheet batch
 * edit and copy, the split, the correction, the approval queue and the AI/MCP ops that reach them.
 */

/** `org_settings` keys (owner only, `PATCH …/time/trust-policy`). */
export const TIME_HAND_ENTRY_KEY = 'time_hand_entry' as const;
export const TIME_HAND_COUNT_KEY = 'time_hand_count' as const;
export const TIME_IDLE_CAP_KEY = 'time_idle_cap_hours' as const;

/** The stored strings read back as a policy; anything unrecognised is the safe default. */
export function storedTimeTrustPolicy(stored: {
  readonly handEntry: string | undefined;
  readonly handCount: string | undefined;
  readonly idleCap: string | undefined;
}): TimeTrustPolicy {
  const hours = stored.idleCap === undefined ? Number.NaN : Number(stored.idleCap);
  return {
    handTimeAllowed: stored.handEntry === 'true',
    handTimeCountMode: isHandTimeCountMode(stored.handCount)
      ? stored.handCount
      : DEFAULT_TIME_TRUST_POLICY.handTimeCountMode,
    idleCapHours: isIdleCapHours(hours) ? hours : DEFAULT_TIME_TRUST_POLICY.idleCapHours,
  };
}

export async function readTimeTrustPolicy(
  runner: TenantQueryRunner,
  context: TenantContext,
  settings: Pick<OrgSettingsRepository, 'findByKey'>,
): Promise<TimeTrustPolicy> {
  const [handEntry, handCount, idleCap] = await Promise.all([
    settings.findByKey(runner, context, TIME_HAND_ENTRY_KEY),
    settings.findByKey(runner, context, TIME_HAND_COUNT_KEY),
    settings.findByKey(runner, context, TIME_IDLE_CAP_KEY),
  ]);
  return storedTimeTrustPolicy({
    handEntry: handEntry?.settingValue,
    handCount: handCount?.settingValue,
    idleCap: idleCap?.settingValue,
  });
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/** A reason, trimmed, or `null` when absent or blank. Over 500 characters is a 400. */
export function optionalReason(raw: unknown, field = 'reason'): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalid(field, 'must be a string');
  const reason = raw.trim();
  if (reason === '') return null;
  if (reason.length > TIME_REASON_MAX) {
    throw invalid(field, `must be ${TIME_REASON_MAX} characters or fewer`);
  }
  return reason;
}

/** A reason that must be there (a correction, a refusal note): 3..500 characters. */
export function requiredReason(raw: unknown, field = 'reason'): string {
  const reason = optionalReason(raw, field);
  if (reason === null || reason.length < TIME_REASON_MIN) {
    throw invalid(field, `must be ${TIME_REASON_MIN} to ${TIME_REASON_MAX} characters`);
  }
  return reason;
}

/**
 * Refuse typed-in minutes unless the owner allows them and a reason is given. The refusal is a
 * 403 with the owner's words (`time.hand_time_off`) or a 400 naming the missing reason, never a
 * bare "forbidden", so a person, the AI and an MCP client all read why.
 */
export function requireHandTimeAllowed(
  policy: TimeTrustPolicy,
  reason: string | null,
  field = 'reason',
): string {
  const refusal = handTimeRefusal(policy, reason);
  if (refusal === 'hand_time_off') {
    throw new ApiError(
      403,
      'forbidden',
      HAND_TIME_REFUSAL_MESSAGES.hand_time_off,
      [{ field: 'source', message: 'hand_time_off' }],
      'time.hand_time_off',
    );
  }
  if (refusal === 'reason_required' || reason === null) {
    throw new ApiError(400, 'validation_failed', HAND_TIME_REFUSAL_MESSAGES.reason_required, [
      { field, message: 'reason_required' },
    ]);
  }
  return reason;
}

/** A measured entry's minutes, day, start and end are the server's (409 `measured_time`). */
export function measuredEditRefused(): ApiError {
  return new ApiError(409, 'conflict', MEASURED_EDIT_REFUSAL, [
    { field: 'minutes', message: 'measured_time' },
  ]);
}

/** Is this row measured (timer or automatic)? */
export function isMeasured(row: Pick<WorkItemTimeLogRow, 'source'>): boolean {
  return timeTrustOf(row.source) === 'measured';
}

/** The state and the stored count of a new or edited hand entry under the owner's policy. */
export function handEntryState(mode: HandTimeCountMode): {
  readonly approvalState: TimeApprovalState;
  readonly counted: boolean;
} {
  const approvalState: TimeApprovalState = 'pending';
  return {
    approvalState,
    counted: entryCounts(
      { source: 'manual', approvalState, needsReview: false, supersededBy: null },
      mode,
    ),
  };
}

/** The stored count of a row after a change of state (the one decision, `entryCounts`). */
export function countedFor(
  row: Pick<WorkItemTimeLogRow, 'source' | 'needsReview' | 'supersededBy'>,
  approvalState: TimeApprovalState,
  mode: HandTimeCountMode,
): boolean {
  return entryCounts(
    {
      source: row.source,
      approvalState,
      needsReview: row.needsReview,
      supersededBy: row.supersededBy,
    },
    mode,
  );
}

/**
 * May this principal approve or refuse this entry? Never one's own; an owner or admin (org-wide
 * `org.manage`) may decide any; a project lead (`project.manage` on the entry's project) may decide
 * the entries of their projects. There is no reporting line in the data model today, so "the
 * person's manager" is the project lead or an admin. One place (AR-8): the queue, the decision and
 * the AI ops all ask this.
 */
export function mayDecideTimeEntry(
  principal: Principal,
  context: TenantContext,
  row: Pick<WorkItemTimeLogRow, 'loggedBy' | 'projectId'>,
): boolean {
  if (principal.kind !== 'internal') return false;
  if (row.loggedBy === context.membershipId) return false;
  const orgWide = authorize({
    principal,
    capability: 'org.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  }).allowed;
  if (orgWide) return true;
  if (row.projectId === null) return false;
  return authorize({
    principal,
    capability: TIME_MANAGE_ANY,
    resource: {
      organizationId: context.organizationId,
      projectId: row.projectId,
      audience: 'internal',
      lifecycle: 'active',
    },
  }).allowed;
}
