import { uuidv7 } from '@tmanage/domain';

/**
 * Synthetic work-item volume — TEST-002's performance fixture, the data half.
 *
 * `18-REPOSITORY-STRUCTURE` §112: "test-kit contains synthetic data only." So this module
 * builds *rows* — plain objects mirroring `work_items`' columns — and never touches a
 * driver, a pool, or SQL. The suite that wants them inserted owns the insertion, with
 * whatever credential its harness holds; what this module owns is that the data is
 * shaped like real load rather than like one row copied a thousand times:
 *
 * - **States cycle through the whole lifecycle** in fixed proportions, so a filtered list
 *   at volume has something to filter — a table of uniform `backlog` rows lets a missing
 *   state predicate pass unnoticed.
 * - **Due dates spread across a year**, before and after "now", so date-ordered indexes
 *   have an ordering worth proving and "late" is a real subset.
 * - **Titles are unique and name their ordinal**, so any duplicated or dropped row in a
 *   paging walk is identifiable by eye in a failure message.
 *
 * No `15-AI-EXECUTION-HANDBOOK` §8 lorem ipsum: titles read like work.
 */

export const SYNTHETIC_WORK_STATES = [
  'backlog',
  'backlog',
  'ready',
  'ready',
  'in_progress',
  'in_progress',
  'in_progress',
  'internal_review',
  'done',
  'done',
] as const;

export const SYNTHETIC_AUDIENCES = [
  'internal',
  'internal',
  'internal',
  'client_visible',
  'client_action_required',
] as const;

export interface SyntheticWorkItemRow {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
  readonly ownerUserId: string | null;
  readonly audience: string;
  readonly dueAt: Date | null;
  readonly version: number;
}

export interface SyntheticWorkVolumeInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly count: number;
  /** The instant "now" spreads around. Injected — synthetic data has no clock of its own. */
  readonly anchor: Date;
  /** Prefixes titles so two volumes in one database stay tellable apart. */
  readonly label?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `count` rows of shaped load. Deterministic in everything but the ids. */
export function syntheticWorkItemRows(
  input: SyntheticWorkVolumeInput,
): readonly SyntheticWorkItemRow[] {
  const rows: SyntheticWorkItemRow[] = [];
  const label = input.label ?? 'Load';
  for (let ordinal = 0; ordinal < input.count; ordinal += 1) {
    const state = SYNTHETIC_WORK_STATES[ordinal % SYNTHETIC_WORK_STATES.length] as string;
    // A sixth of the rows carry no due date at all — the null case every date ordering
    // has to answer for.
    const hasDue = ordinal % 6 !== 5;
    // Spread across ±180 days around the anchor, interleaved — past, future, past,
    // future — so both sides exist at ANY volume, not only past day 180.
    const magnitude = ((ordinal >> 1) % 180) + 1;
    const offsetDays = ordinal % 2 === 0 ? -magnitude : magnitude;
    rows.push({
      id: uuidv7(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      type: 'task',
      title: `${label} item ${String(ordinal + 1).padStart(4, '0')}`,
      state,
      ownerUserId: null,
      audience: SYNTHETIC_AUDIENCES[ordinal % SYNTHETIC_AUDIENCES.length] as string,
      dueAt: hasDue ? new Date(input.anchor.getTime() + offsetDays * DAY_MS) : null,
      version: 1,
    });
  }
  return rows;
}
