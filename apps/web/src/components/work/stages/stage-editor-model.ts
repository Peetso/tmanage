/**
 * Work area v2 stages editor (W-WEB-5): the pure rules the stages editor, the new-set dialog and
 * the delete-stage confirm share (no I/O, IP-3), proved in `tests/work-stage-editor-model.test.ts`.
 *
 * The set rules are the API's (`apps/api/src/modules/work/stages/stage-rules.ts`
 * `checkSetRules`): at least one "Not started" and one "In progress" stage, exactly one "Done"
 * stage, at most 30 stages. The screen applies them before a request, so a control that could only
 * earn a 422 is not offered (Norman's constraints, UX-3); the API stays the authority.
 */
import type {
  NewStageInput,
  StageGroup,
  StageSetView,
  StageStateKey,
  StageView,
} from '../../../lib/api/work-stages';
import {
  GROUP_KEY,
  GROUP_STATE,
  orderedStages,
  STAGE_GROUPS,
  STAGE_TEMPLATES,
} from './stage-model';

/** The API's `MAX_STAGES_PER_SET` and `MAX_STAGE_NAME_LENGTH`. */
export const MAX_STAGES_PER_SET = 30;
export const MAX_STAGE_NAME_LENGTH = 120;

/**
 * The built-in stages a workspace without a default set uses: a mirror of the API's
 * `BUILT_IN_STAGES` (`stage-rules.ts`), which `GET work/stage-sets` does not list. Read-only; the
 * names are drawn from the state labels (`BUILT_IN_NAME_KEY`).
 */
export const BUILT_IN_SET: StageSetView = {
  id: 'builtin',
  name: 'Default',
  scope: 'workspace',
  projectId: null,
  isDefault: true,
  isBuiltIn: true,
  version: 0,
  projectCount: 0,
  stages: (
    [
      ['backlog', 'not_started'],
      ['ready', 'not_started'],
      ['in_progress', 'in_progress'],
      ['internal_review', 'in_review'],
      ['done', 'done'],
    ] as const
  ).map(([stateKey, group], position) => ({
    id: `builtin:${stateKey}`,
    name: stateKey,
    stateKey,
    group,
    colorKey: null,
    position,
    workCount: 0,
  })),
  createdAt: null,
  updatedAt: null,
};

/** The sets the editor lists: the stored ones, after the built-in stages while no set is the default. */
export function editorSets(stored: readonly StageSetView[]): readonly StageSetView[] {
  return stored.some((set) => set.isDefault) ? stored : [BUILT_IN_SET, ...stored];
}

export function stagesInGroup(set: StageSetView, group: StageGroup): StageView[] {
  return orderedStages(set.stages).filter((stage) => stage.group === group);
}

/** "Done" holds exactly one stage, so no second one is offered; a set holds at most 30. */
export function canAddTo(set: StageSetView, group: StageGroup): boolean {
  return group !== 'done' && set.stages.length < MAX_STAGES_PER_SET;
}

/** Where a stage added to `group` goes in the set's order: after the last stage of its group. */
export function addPosition(set: StageSetView, group: StageGroup): number {
  const rank = STAGE_GROUPS.indexOf(group);
  let at = 0;
  orderedStages(set.stages).forEach((stage, index) => {
    if (STAGE_GROUPS.indexOf(stage.group) <= rank) at = index + 1;
  });
  return at;
}

export type DeleteBlock = 'onlyDone' | 'lastNotStarted' | 'lastInProgress';

/** Why a stage cannot go (the set would break a rule), or `null` when it may. */
export function deleteBlock(set: StageSetView, stage: StageView): DeleteBlock | null {
  if (stage.group === 'done') return 'onlyDone';
  if (stagesInGroup(set, stage.group).length > 1) return null;
  if (stage.group === 'not_started') return 'lastNotStarted';
  if (stage.group === 'in_progress') return 'lastInProgress';
  return null;
}

export const DELETE_BLOCK_KEY: Readonly<Record<DeleteBlock, string>> = {
  onlyDone: 'WorkStages.editor.blockDone',
  lastNotStarted: 'WorkStages.editor.blockNotStarted',
  lastInProgress: 'WorkStages.editor.blockInProgress',
};

/** The stages a deleted stage's works may move to: the API takes only one of the same state. */
export function moveTargets(set: StageSetView, stage: StageView): StageView[] {
  return orderedStages(set.stages).filter(
    (other) => other.id !== stage.id && other.stateKey === stage.stateKey,
  );
}

/**
 * The whole set's order after moving one stage a step up (-1) or down (+1) inside its group, or
 * `null` at the group's edge. A stage never leaves its group by a move: its group is its state,
 * which a reorder does not change.
 */
export function orderAfterStep(set: StageSetView, stageId: string, step: -1 | 1): string[] | null {
  const stage = set.stages.find((s) => s.id === stageId);
  if (!stage) return null;
  const group = stagesInGroup(set, stage.group).map((s) => s.id);
  const other = group[group.indexOf(stageId) + step];
  if (other === undefined) return null;
  const ids = orderedStages(set.stages).map((s) => s.id);
  const a = ids.indexOf(stageId);
  const b = ids.indexOf(other);
  ids[a] = other;
  ids[b] = stageId;
  return ids;
}

/**
 * The whole set's order after dropping `stageId` on `targetId` (the drag handle's path; the
 * menu's Move up / Move down is the single-pointer path, WCAG 2.2 SC 2.5.7). Dragged down, the
 * stage lands after the target; dragged up, before it. `null` across groups or for no change.
 */
export function orderAfterDrop(
  set: StageSetView,
  stageId: string,
  targetId: string,
): string[] | null {
  if (stageId === targetId) return null;
  const all = orderedStages(set.stages);
  const from = all.findIndex((s) => s.id === stageId);
  const onto = all.findIndex((s) => s.id === targetId);
  if (from < 0 || onto < 0 || all[from]?.group !== all[onto]?.group) return null;
  const ids = all.map((s) => s.id).filter((id) => id !== stageId);
  const at = ids.indexOf(targetId);
  ids.splice(onto > from ? at + 1 : at, 0, stageId);
  return ids;
}

export type NameError = 'empty' | 'tooLong' | 'taken';

/** A trimmed stage name, or why it cannot be saved (empty, too long, already in the set). */
export function checkStageName(
  name: string,
  set: StageSetView | null,
  exceptId?: string,
): { readonly name: string } | { readonly error: NameError } {
  const trimmed = name.trim();
  if (trimmed === '') return { error: 'empty' };
  if (trimmed.length > MAX_STAGE_NAME_LENGTH) return { error: 'tooLong' };
  if (set?.stages.some((stage) => stage.id !== exceptId && stage.name === trimmed)) {
    return { error: 'taken' };
  }
  return { name: trimmed };
}

/** A trimmed set name, or why it cannot be saved (the API refuses a second set of that name). */
export function checkSetName(
  name: string,
  sets: readonly StageSetView[],
  exceptId?: string,
): { readonly name: string } | { readonly error: NameError } {
  const trimmed = name.trim();
  if (trimmed === '') return { error: 'empty' };
  if (trimmed.length > MAX_STAGE_NAME_LENGTH) return { error: 'tooLong' };
  if (sets.some((set) => !set.isBuiltIn && set.id !== exceptId && set.name === trimmed)) {
    return { error: 'taken' };
  }
  return { name: trimmed };
}

export const NAME_ERROR_KEY: Readonly<Record<NameError, string>> = {
  empty: 'WorkStages.editor.nameEmpty',
  tooLong: 'WorkStages.editor.nameTooLong',
  taken: 'WorkStages.editor.nameTaken',
};

export type SetStart = 'simple' | 'designThinking' | 'empty';
export const SET_STARTS: readonly SetStart[] = ['simple', 'designThinking', 'empty'];

/** "Start empty": one stage in each group, named after the group. */
const EMPTY_START: readonly { readonly nameKey: string; readonly stateKey: StageStateKey }[] =
  STAGE_GROUPS.map((group) => ({ nameKey: GROUP_KEY[group], stateKey: GROUP_STATE[group] }));

/** The stages a new set starts with, named in the reader's language. */
export function startStages(start: SetStart, t: (key: string) => string): NewStageInput[] {
  const rows = start === 'empty' ? EMPTY_START : STAGE_TEMPLATES[start];
  return rows.map((row) => ({ name: t(row.nameKey), stateKey: row.stateKey }));
}

/** A set copied: the same stages under a name no other set has ("Design thinking copy 2"). */
export function copyOf(
  set: StageSetView,
  taken: readonly string[],
  baseName: string,
  stageName: (stage: StageView) => string,
): { readonly name: string; readonly stages: NewStageInput[] } {
  let name = baseName;
  for (let n = 2; taken.includes(name); n += 1) name = `${baseName} ${n}`;
  return {
    name,
    stages: orderedStages(set.stages).map((stage) => ({
      name: stageName(stage),
      stateKey: stage.stateKey as StageStateKey,
      colorKey: stage.colorKey,
    })),
  };
}

/** The count key for "1 project", "2 projects" (Arabic has a dual), "{count} projects". */
export function projectsKey(count: number): string {
  if (count === 1) return 'WorkStages.editor.projectsOne';
  if (count === 2) return 'WorkStages.editor.projectsTwo';
  return 'WorkStages.editor.projectsMany';
}

/** The delete lede for the works on a stage: "3 work items are in this stage. Move them to:". */
export function worksOnStageKey(count: number): string {
  if (count === 1) return 'WorkStages.editor.deleteMoveOne';
  if (count === 2) return 'WorkStages.editor.deleteMoveTwo';
  return 'WorkStages.editor.deleteMoveMany';
}
