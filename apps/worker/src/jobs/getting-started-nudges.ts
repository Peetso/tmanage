import { isInQuietHours } from '@tmanage/domain';
import type { QuietHoursPreferences } from '@tmanage/domain';

/**
 * 55-24 — first-week nudges for the getting-started checklist.
 *
 * For every active member in their first {@link NUDGE_WINDOW_DAYS} days who has not dismissed the
 * checklist, one in-app notice names the next unfinished step. At most one a day: the notice's
 * dedupe key carries the member and the UTC day, so a second sweep the same day inserts nothing.
 * A member who turned in-app notices off, is inside their quiet hours, or has nothing left to do
 * is skipped (quiet hours only defer — the next hourly sweep that day can still send).
 *
 * The step order and the "done" signals mirror the API's `getting-started.steps.ts`; the SQL lives
 * in `common/database/getting-started-nudge-store.ts`.
 */

export const NUDGE_WINDOW_DAYS = 7;
export const GETTING_STARTED_NUDGE_TYPE = 'getting_started.nudge.v1';
export const GETTING_STARTED_OBJECT_TYPE = 'getting_started_step';

export const NUDGE_STEPS = [
  'invite_teammate',
  'create_project',
  'add_client',
  'connect_storage',
  'set_working_hours',
  'try_ai_assistant',
] as const;
export type NudgeStep = (typeof NUDGE_STEPS)[number];

/** One first-week member, with everything the decision needs. */
export interface NudgeCandidate {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly joinedAt: Date;
  readonly inAppEnabled: boolean;
  readonly quietHours: QuietHoursPreferences | null;
  readonly dismissed: boolean;
  /** Steps done by data or by hand. */
  readonly done: ReadonlySet<NudgeStep>;
}

export interface NudgeStore {
  listCandidates(now: Date): Promise<readonly NudgeCandidate[]>;
  /** Insert the day's notice; false when one already exists (the dedupe key). */
  sendNudge(candidate: NudgeCandidate, step: NudgeStep, dedupeKey: string): Promise<boolean>;
}

export type NudgeDecision =
  | { readonly send: true; readonly step: NudgeStep; readonly dedupeKey: string }
  | { readonly send: false; readonly reason: string };

/** The dedupe key: one notice per member per UTC day. */
export function nudgeDedupeKey(membershipId: string, now: Date): string {
  return `getting_started:${membershipId}:${now.toISOString().slice(0, 10)}`;
}

export function decideNudge(candidate: NudgeCandidate, now: Date): NudgeDecision {
  const ageMs = now.getTime() - candidate.joinedAt.getTime();
  if (ageMs < 0 || ageMs >= NUDGE_WINDOW_DAYS * 86_400_000) {
    return { send: false, reason: 'outside_first_week' };
  }
  if (candidate.dismissed) return { send: false, reason: 'dismissed' };
  if (!candidate.inAppEnabled) return { send: false, reason: 'in_app_off' };
  if (isInQuietHours(now, candidate.quietHours)) return { send: false, reason: 'quiet_hours' };
  const step = NUDGE_STEPS.find((s) => !candidate.done.has(s));
  if (step === undefined) return { send: false, reason: 'all_done' };
  return { send: true, step, dedupeKey: nudgeDedupeKey(candidate.membershipId, now) };
}

export interface NudgeSweepResult {
  readonly candidates: number;
  readonly sent: number;
}

export async function sweepGettingStartedNudges(
  store: NudgeStore,
  now: Date = new Date(),
): Promise<NudgeSweepResult> {
  const candidates = await store.listCandidates(now);
  let sent = 0;
  for (const candidate of candidates) {
    const decision = decideNudge(candidate, now);
    if (decision.send && (await store.sendNudge(candidate, decision.step, decision.dedupeKey))) {
      sent += 1;
    }
  }
  return { candidates: candidates.length, sent };
}
