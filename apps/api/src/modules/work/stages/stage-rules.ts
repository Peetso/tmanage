import type { WorkItemState } from '@tmanage/domain';

/**
 * Work area D1 (2026-11-23): the pure rules of stage sets. No I/O, so every rule is unit-tested
 * without a database and the service, the repository and the work-items transition share one copy.
 *
 * A stage is a **named place inside one of the work-item states**. The state machine
 * (`packages/domain/src/state-machines/work-item.ts`) is unchanged: moving a work to a stage runs
 * the ordinary transition to the stage's `stateKey`, so the machine's legal edges, the supervisor
 * rule and the audit trail hold for every stage move.
 *
 * The editor (WORK-AREA-REVIEW-AND-PLAN §5.5) shows four fixed groups in order — Not started · In
 * progress · In review · Done. A set needs at least one "Not started" stage, at least one "In
 * progress" stage and exactly one "Done" stage; "In review" is optional, and a set without it
 * refuses a move into `internal_review` (the "transitions respect the set" rule).
 */

/** The states a stage may sit in. `blocked` and `archived` stay system states, never stages. */
export const STAGE_STATE_KEYS = [
  'backlog',
  'ready',
  'in_progress',
  'internal_review',
  'done',
] as const satisfies readonly WorkItemState[];
export type StageStateKey = (typeof STAGE_STATE_KEYS)[number];

export const STAGE_GROUPS = ['not_started', 'in_progress', 'in_review', 'done'] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number];

/** Where a set was made. `project` sets belong to one project and its managers edit them. */
export const STAGE_SET_SCOPES = ['workspace', 'project', 'custom'] as const;
export type StageSetScope = (typeof STAGE_SET_SCOPES)[number];

/** The design palette's stage colours (`packages/ui` tokens); a stage without one is neutral. */
export const STAGE_COLOR_KEYS = [
  'neutral',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'purple',
  'pink',
] as const;

export const MAX_STAGES_PER_SET = 30;
export const MAX_STAGE_NAME_LENGTH = 120;
export const MAX_STAGE_SETS_PER_WORKSPACE = 100;

/** The id prefix of the built-in set's stages; never stored. */
export const BUILT_IN_SET_ID = 'builtin';

export function isStageStateKey(value: unknown): value is StageStateKey {
  return typeof value === 'string' && (STAGE_STATE_KEYS as readonly string[]).includes(value);
}

export function isStageColorKey(value: unknown): value is (typeof STAGE_COLOR_KEYS)[number] {
  return typeof value === 'string' && (STAGE_COLOR_KEYS as readonly string[]).includes(value);
}

/** The editor group a state belongs to; `null` for the system states. */
export function groupOfState(state: string): StageGroup | null {
  switch (state) {
    case 'backlog':
    case 'ready':
      return 'not_started';
    case 'in_progress':
      return 'in_progress';
    case 'internal_review':
      return 'in_review';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

/** The smallest shape the rules need: a stage's id, state, order (and a name to show). */
export interface StageLike {
  readonly id: string;
  readonly name: string;
  readonly stateKey: string;
  readonly position: number;
}

/** The built-in stages a workspace without any set of its own uses (the four groups). */
export const BUILT_IN_STAGES: readonly StageLike[] = [
  { id: `${BUILT_IN_SET_ID}:backlog`, name: 'Backlog', stateKey: 'backlog', position: 0 },
  { id: `${BUILT_IN_SET_ID}:ready`, name: 'To do', stateKey: 'ready', position: 1 },
  {
    id: `${BUILT_IN_SET_ID}:in_progress`,
    name: 'In progress',
    stateKey: 'in_progress',
    position: 2,
  },
  {
    id: `${BUILT_IN_SET_ID}:internal_review`,
    name: 'In review',
    stateKey: 'internal_review',
    position: 3,
  },
  { id: `${BUILT_IN_SET_ID}:done`, name: 'Done', stateKey: 'done', position: 4 },
];

/** Stages in board order: position, then id, so equal positions still sort the same everywhere. */
export function ordered<T extends StageLike>(stages: readonly T[]): T[] {
  return [...stages].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** A broken set rule: which rule, said plainly (shown to the person who edits the set). */
export interface SetRuleBreak {
  readonly rule: 'needs_not_started' | 'needs_in_progress' | 'needs_one_done' | 'too_many';
  readonly message: string;
}

/**
 * The set rules from the editor: ≥ 1 "Not started", ≥ 1 "In progress", exactly 1 "Done", at most
 * {@link MAX_STAGES_PER_SET} stages. Returns the first rule broken, or `null` when the set is fine.
 */
export function checkSetRules(stages: readonly StageLike[]): SetRuleBreak | null {
  const count = (group: StageGroup) =>
    stages.filter((stage) => groupOfState(stage.stateKey) === group).length;
  if (stages.length > MAX_STAGES_PER_SET) {
    return { rule: 'too_many', message: `A set holds at most ${MAX_STAGES_PER_SET} stages` };
  }
  if (count('not_started') < 1) {
    return { rule: 'needs_not_started', message: 'A set needs at least one "Not started" stage' };
  }
  if (count('in_progress') < 1) {
    return { rule: 'needs_in_progress', message: 'A set needs at least one "In progress" stage' };
  }
  if (count('done') !== 1) {
    return { rule: 'needs_one_done', message: 'A set needs exactly one "Done" stage' };
  }
  return null;
}

/** Whether a work in `state` has a place in this set (system states always do). */
export function setCoversState(stages: readonly StageLike[], state: string): boolean {
  const group = groupOfState(state);
  if (group === null) return true;
  return stages.some((stage) => groupOfState(stage.stateKey) === group);
}

/**
 * The stage a work shows: its own `stageId` when that stage is in the set and has the work's
 * state; else the first stage with the work's exact state; else the first stage of the state's
 * group; else `null` (a system state, or a set without the group).
 */
export function stageForWork<T extends StageLike>(
  stages: readonly T[],
  state: string,
  stageId: string | null | undefined,
): T | null {
  const inOrder = ordered(stages);
  if (stageId) {
    const own = inOrder.find((stage) => stage.id === stageId);
    if (own && own.stateKey === state) return own;
  }
  const exact = inOrder.find((stage) => stage.stateKey === state);
  if (exact) return exact;
  const group = groupOfState(state);
  if (group === null) return null;
  return inOrder.find((stage) => groupOfState(stage.stateKey) === group) ?? null;
}

/**
 * After a transition to `to`, the `stage_id` a work keeps: the stage the caller asked for, else
 * its current stage when that stage still has the new state, else `null` (the derived stage).
 */
export function stageIdAfterTransition(
  stages: readonly StageLike[],
  to: string,
  currentStageId: string | null | undefined,
  requestedStageId?: string | null,
): string | null {
  if (requestedStageId) return requestedStageId;
  if (!currentStageId) return null;
  const current = stages.find((stage) => stage.id === currentStageId);
  return current && current.stateKey === to ? currentStageId : null;
}

/** Whether `ids` is exactly the set's stage ids in some order (each once). */
export function isPermutationOf(ids: readonly string[], stages: readonly StageLike[]): boolean {
  if (ids.length !== stages.length) return false;
  const want = new Set(stages.map((stage) => stage.id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!want.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
