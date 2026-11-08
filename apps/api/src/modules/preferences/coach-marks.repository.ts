import { uuidv7 } from '@tmanage/domain';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { DEFAULT_USER_PREFERENCES } from './preferences.controller.js';

/** The three first-visit tours (row 55-09). */
export const COACH_MARK_TOURS = ['my_day', 'projects', 'work_board'] as const;
export type CoachMarkTour = (typeof COACH_MARK_TOURS)[number];

/** How a tour ended: walked to the last step, or skipped. */
export const COACH_MARK_OUTCOMES = ['done', 'skipped'] as const;
export type CoachMarkOutcome = (typeof COACH_MARK_OUTCOMES)[number];

/** What is kept under `coachMarks` in the caller's own `user_preferences.prefs_json`. */
export interface CoachMarksState {
  readonly my_day?: CoachMarkOutcome;
  readonly projects?: CoachMarkOutcome;
  readonly work_board?: CoachMarkOutcome;
  readonly neverAgain?: boolean;
}

/**
 * Row 55-09 coach-mark state, stored as `coachMarks` beside the appearance keys in the caller's
 * own `user_preferences.prefs_json` — no new table or column. The write is one upsert whose
 * `json_merge_patch` merges nested objects, so finishing one tour never forgets another and the
 * appearance / privacy keys stay as they were.
 */
export class CoachMarksRepository {
  async read(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<CoachMarksState> {
    const rows = await runner.execute<QueryRows>(
      `select json_extract(prefs_json, '$.coachMarks') as coach_marks
         from user_preferences
        where organization_id = ? and membership_id = ?
        limit 1`,
      [context.organizationId, membershipId],
    );
    const raw = rows[0]?.['coach_marks'];
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return typeof parsed === 'object' && parsed !== null ? (parsed as CoachMarksState) : {};
  }

  async merge(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    patch: CoachMarksState,
  ): Promise<void> {
    const json = JSON.stringify({ coachMarks: patch });
    await runner.execute(
      `insert into user_preferences
         (id, organization_id, membership_id, prefs_json, created_at, updated_at)
       values (?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
       on duplicate key update prefs_json = json_merge_patch(prefs_json, ?),
                               updated_at = current_timestamp(3)`,
      [
        uuidv7(),
        context.organizationId,
        membershipId,
        JSON.stringify({ ...DEFAULT_USER_PREFERENCES, coachMarks: patch }),
        json,
      ],
    );
  }
}
