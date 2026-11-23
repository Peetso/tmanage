/**
 * Work area v2 stages on the web: the pure rules the stage control, the stage editor and the
 * board share (no I/O, IP-3), proved in `tests/work-stage-model.test.ts`.
 *
 * A stage is a named place inside one work state (`stateKey`); the four editor groups are fixed
 * (Not started · In progress · In review · Done). The API's `stage-rules.ts` is the server copy
 * of the same rules; this file only decides what the screens show and which moves to ask for.
 */
import { workItemStateMachine } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import type {
  StageGroup,
  StageSetView,
  StageStateKey,
  StageView,
} from '../../../lib/api/work-stages';

export const STAGE_GROUPS: readonly StageGroup[] = [
  'not_started',
  'in_progress',
  'in_review',
  'done',
];

/** The catalog key of each group's name ("Not started", "In progress", …). */
export const GROUP_KEY: Readonly<Record<StageGroup, string>> = {
  not_started: 'WorkStages.group.notStarted',
  in_progress: 'WorkStages.group.inProgress',
  in_review: 'WorkStages.group.inReview',
  done: 'WorkStages.group.done',
};

/** The state a new stage of a group sits in. */
export const GROUP_STATE: Readonly<Record<StageGroup, StageStateKey>> = {
  not_started: 'ready',
  in_progress: 'in_progress',
  in_review: 'internal_review',
  done: 'done',
};

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

/** The built-in stages' names come from the state labels (the API sends no name to show). */
export const BUILT_IN_NAME_KEY: Readonly<Record<string, string>> = {
  backlog: 'WorkListScreen.stateBacklog',
  ready: 'WorkListScreen.stateReady',
  in_progress: 'WorkListScreen.stateInProgress',
  internal_review: 'WorkListScreen.stateInternalReview',
  done: 'WorkListScreen.stateDone',
};

/** Stages in board order: position, then id. */
export function orderedStages(stages: readonly StageView[]): StageView[] {
  return [...stages].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * The stage set a work uses: the set holding its current stage (its own set, or its project's);
 * without a stage id, the project's set. `null` when nothing is loaded yet.
 */
export function effectiveSetForWork(
  stageId: string | null | undefined,
  sets: readonly StageSetView[],
  projectSet: StageSetView | null,
): StageSetView | null {
  if (stageId) {
    if (projectSet?.stages.some((stage) => stage.id === stageId)) return projectSet;
    const own = sets.find((set) => set.stages.some((stage) => stage.id === stageId));
    if (own) return own;
  }
  return projectSet;
}

/** The stage a work is on: its stored stage, else the first stage of its state. */
export function currentStage(
  set: StageSetView | null,
  stageId: string | null | undefined,
  state: string,
): StageView | null {
  if (!set) return null;
  const stages = orderedStages(set.stages);
  return (
    stages.find((stage) => stage.id === stageId) ??
    stages.find((stage) => stage.stateKey === state) ??
    null
  );
}

/**
 * How to reach `to` from `from`: the moves to run first (each needs no facts) and the facts the
 * last move needs. `null` when no such run exists (archived, a blocked item, a set without the
 * state). Mirrors `pathToDone` on the work page, for any target state.
 */
export function movesTo(
  from: WorkItemState,
  to: WorkItemState,
): { readonly before: readonly WorkItemState[]; readonly needs: readonly string[] } | null {
  if (from === to) return { before: [], needs: [] };
  const queue: (readonly WorkItemState[])[] = [[from]];
  const seen = new Set<WorkItemState>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as readonly WorkItemState[];
    const at = path[path.length - 1] as WorkItemState;
    for (const next of workItemStateMachine.allowedFrom(at)) {
      const needs = workItemStateMachine.requirementsFor(at, next);
      if (next === to) return { before: path.slice(1), needs };
      if (needs.length > 0 || seen.has(next) || next === 'archived' || next === 'blocked') continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/** Facts the screen fills itself; anything else (a reopen reason, a resolution) is asked for. */
export function autoFacts(
  needs: readonly string[],
  ownerUserId: string | null,
  now: Date,
): { readonly facts: Record<string, string>; readonly ask: readonly string[] } {
  const facts: Record<string, string> = {};
  const ask: string[] = [];
  for (const need of needs) {
    if (need === 'completedAt') facts[need] = now.toISOString();
    else if (need === 'ownerId' && ownerUserId !== null) facts[need] = ownerUserId;
    else ask.push(need);
  }
  return { facts, ask };
}

/** The CSS colour token of a stage dot: its own colour, else its group's. */
export function stageColorVar(stage: Pick<StageView, 'colorKey' | 'group'>): string {
  const own: Record<string, string> = {
    neutral: 'var(--ink-500)',
    blue: 'var(--info-600, var(--ink-650))',
    teal: 'var(--success-600)',
    green: 'var(--success-600)',
    amber: 'var(--warning-600)',
    orange: 'var(--warning-600)',
    red: 'var(--danger-600)',
    purple: 'var(--client-500)',
    pink: 'var(--client-500)',
  };
  if (stage.colorKey && own[stage.colorKey]) return own[stage.colorKey] as string;
  return groupColorVar(stage.group);
}

export function groupColorVar(group: StageGroup): string {
  switch (group) {
    case 'not_started':
      return 'var(--ink-500)';
    case 'in_progress':
      return 'var(--lime-500)';
    case 'in_review':
      return 'var(--warning-600)';
    case 'done':
      return 'var(--success-600)';
  }
}

/** The two templates offered when a set is made (plan §5.5), names from the catalogs. */
export const STAGE_TEMPLATES = {
  simple: [
    { nameKey: 'WorkStages.template.toDo', stateKey: 'ready' },
    { nameKey: 'WorkStages.template.inProgress', stateKey: 'in_progress' },
    { nameKey: 'WorkStages.template.inReview', stateKey: 'internal_review' },
    { nameKey: 'WorkStages.template.done', stateKey: 'done' },
  ],
  designThinking: [
    { nameKey: 'WorkStages.template.empathize', stateKey: 'ready' },
    { nameKey: 'WorkStages.template.define', stateKey: 'in_progress' },
    { nameKey: 'WorkStages.template.ideate', stateKey: 'in_progress' },
    { nameKey: 'WorkStages.template.prototype', stateKey: 'in_progress' },
    { nameKey: 'WorkStages.template.test', stateKey: 'internal_review' },
    { nameKey: 'WorkStages.template.done', stateKey: 'done' },
  ],
} as const satisfies Record<
  string,
  readonly { readonly nameKey: string; readonly stateKey: StageStateKey }[]
>;
export type StageTemplate = keyof typeof STAGE_TEMPLATES;
