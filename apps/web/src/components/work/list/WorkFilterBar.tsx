'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import type { WorkItemState } from '@tmanage/domain';
import type { StageGroup, StageSetView } from '../../../lib/api/work-stages';
import type { MemberSummary } from '../../../lib/api/members';
import type { TeamView } from '../../../lib/api/people-teams';
import { useA6T } from '../DueDatePicker';
import { useDismiss } from '../use-dismiss';
import { ChevronDownIcon } from '../work-icons';
import { orderedStages, stageColorVar, groupColorVar } from '../stages/stage-model';
import { DUE_FILTERS, ME, type DueFilter, type WorkListFilters } from './work-list-model';

/** The states each stage group stands for when no project set names the stages. */
const GROUP_STATES: Readonly<Record<StageGroup, readonly WorkItemState[]>> = {
  not_started: ['backlog', 'ready'],
  in_progress: ['in_progress'],
  in_review: ['internal_review'],
  done: ['done'],
};
const GROUPS: readonly StageGroup[] = ['not_started', 'in_progress', 'in_review', 'done'];

export const GROUP_NAME_KEY: Readonly<Record<StageGroup, string>> = {
  not_started: 'WorkListScreen.groupNotStarted',
  in_progress: 'WorkListScreen.groupInProgress',
  in_review: 'WorkListScreen.groupInReview',
  done: 'WorkListScreen.groupDone',
};

const DUE_KEY: Readonly<Record<DueFilter, string>> = {
  any: 'WorkListScreen.dueAny',
  overdue: 'WorkListScreen.dueOverdue',
  today: 'WorkListScreen.dueToday',
  week: 'WorkListScreen.dueWeek',
  month: 'WorkListScreen.dueMonth',
  none: 'WorkListScreen.dueNone',
};

export interface WorkFilterBarProps {
  readonly filters: WorkListFilters;
  readonly onChange: (next: WorkListFilters) => void;
  /** Inert until the projects have answered (I-3): a choice made before then would be lost. */
  readonly disabled: boolean;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** The chosen project's own named stages; `null` = the four groups. */
  readonly projectSet: StageSetView | null;
  readonly members: readonly MemberSummary[];
  readonly viewerUserId: string | null;
  readonly teams: readonly TeamView[];
}

/**
 * The toolbar's five filters (Figma `WV2-01`: Project · Stage · Doer · Team · Due). Each is a
 * 32 px control that opens a small popover of native radios or checkboxes (UX-9: native HTML
 * first); Escape or a press outside closes it (`useDismiss`, APG disclosure). A set filter shows
 * its value on the control, so the toolbar always says what the list is narrowed to.
 */
export function WorkFilterBar({
  filters,
  onChange,
  disabled,
  projects,
  projectSet,
  members,
  viewerUserId,
  teams,
}: WorkFilterBarProps) {
  const t = useA6T();
  const set = (patch: Partial<WorkListFilters>) => onChange({ ...filters, ...patch });

  const project = projects.find((entry) => entry.id === filters.projectId);
  const team = teams.find((entry) => entry.id === filters.teamId);
  const doerName =
    filters.doer === ME
      ? t('WorkListScreen.doerMe')
      : (members.find((member) => member.userId === filters.doer)?.displayName ?? '');
  const stages = projectSet ? orderedStages(projectSet.stages) : [];
  const stageCount = filters.stageIds.length + filters.states.length;
  const singleStage =
    filters.stageIds.length === 1 && filters.states.length === 0
      ? stages.find((stage) => stage.id === filters.stageIds[0])?.name
      : undefined;

  const toggleStates = (states: readonly WorkItemState[]) => {
    const on = states.every((state) => filters.states.includes(state));
    set({
      states: on
        ? filters.states.filter((state) => !states.includes(state))
        : [...filters.states, ...states.filter((state) => !filters.states.includes(state))],
    });
  };
  const toggleStage = (id: string) =>
    set({
      stageIds: filters.stageIds.includes(id)
        ? filters.stageIds.filter((entry) => entry !== id)
        : [...filters.stageIds, id],
    });

  return (
    <fieldset className="tm-wl-filters" disabled={disabled}>
      <legend className="tm-visually-hidden">{t('WorkListScreen.filters')}</legend>

      <FilterMenu label={t('WorkListScreen.projectLabel')} value={project?.name} kind="radio">
        {(close) => (
          <>
            <Choice
              kind="radio"
              name="project"
              checked={filters.projectId === ''}
              onPick={() => {
                // Another project's stages mean nothing here, so a named stage filter goes too.
                set({ projectId: '', stageIds: [] });
                close();
              }}
            >
              {t('WorkListScreen.allProjects')}
            </Choice>
            {projects.map((entry) => (
              <Choice
                key={entry.id}
                kind="radio"
                name="project"
                checked={filters.projectId === entry.id}
                onPick={() => {
                  set({ projectId: entry.id, stageIds: [] });
                  close();
                }}
              >
                <bdi>{entry.name}</bdi>
              </Choice>
            ))}
          </>
        )}
      </FilterMenu>

      <FilterMenu
        label={t('WorkListScreen.stageLabel')}
        value={
          stageCount === 0
            ? undefined
            : (singleStage ?? t('WorkListScreen.stageCount', { count: stageCount }))
        }
        kind="checkbox"
      >
        {() => (
          <>
            {stages.length > 0
              ? stages.map((stage) => (
                  <Choice
                    key={stage.id}
                    kind="checkbox"
                    name="stage"
                    checked={filters.stageIds.includes(stage.id)}
                    dot={stageColorVar(stage)}
                    onPick={() => toggleStage(stage.id)}
                  >
                    <bdi>{stage.name}</bdi>
                  </Choice>
                ))
              : GROUPS.map((group) => (
                  <Choice
                    key={group}
                    kind="checkbox"
                    name="stage"
                    checked={GROUP_STATES[group].every((state) => filters.states.includes(state))}
                    dot={groupColorVar(group)}
                    onPick={() => toggleStates(GROUP_STATES[group])}
                  >
                    {t(GROUP_NAME_KEY[group])}
                  </Choice>
                ))}
            {(['blocked', 'archived'] as const).map((state) => (
              <Choice
                key={state}
                kind="checkbox"
                name="stage"
                checked={filters.states.includes(state)}
                onPick={() => toggleStates([state])}
              >
                {t(
                  state === 'blocked'
                    ? 'WorkListScreen.stateBlocked'
                    : 'WorkListScreen.stateArchived',
                )}
              </Choice>
            ))}
          </>
        )}
      </FilterMenu>

      <FilterMenu label={t('WorkListScreen.doerLabel')} value={doerName || undefined} kind="radio">
        {(close) => (
          <>
            {[
              { id: '', name: t('WorkListScreen.doerAnyone') },
              ...(viewerUserId === null ? [] : [{ id: ME, name: t('WorkListScreen.doerMe') }]),
              ...members
                .filter((member) => member.userId !== viewerUserId)
                .map((member) => ({ id: member.userId, name: member.displayName })),
            ].map((entry) => (
              <Choice
                key={entry.id || 'anyone'}
                kind="radio"
                name="doer"
                checked={filters.doer === entry.id}
                onPick={() => {
                  set({ doer: entry.id });
                  close();
                }}
              >
                <bdi>{entry.name}</bdi>
              </Choice>
            ))}
          </>
        )}
      </FilterMenu>

      <FilterMenu label={t('WorkListScreen.teamLabel')} value={team?.name} kind="radio">
        {(close) => (
          <>
            {[{ id: '', name: t('WorkListScreen.teamAny') }, ...teams].map((entry) => (
              <Choice
                key={entry.id || 'any'}
                kind="radio"
                name="team"
                checked={filters.teamId === entry.id}
                onPick={() => {
                  set({ teamId: entry.id });
                  close();
                }}
              >
                <bdi>{entry.name}</bdi>
              </Choice>
            ))}
          </>
        )}
      </FilterMenu>

      <FilterMenu
        label={t('WorkListScreen.dueLabel')}
        value={filters.due === 'any' ? undefined : t(DUE_KEY[filters.due])}
        kind="radio"
      >
        {(close) => (
          <>
            {DUE_FILTERS.map((due) => (
              <Choice
                key={due}
                kind="radio"
                name="due"
                checked={filters.due === due}
                onPick={() => {
                  set({ due });
                  close();
                }}
              >
                {t(DUE_KEY[due])}
              </Choice>
            ))}
          </>
        )}
      </FilterMenu>
    </fieldset>
  );
}

/**
 * One filter control: the label (or the chosen value) and a chevron; the popover holds one group
 * of radios or checkboxes named by the label.
 */
function FilterMenu({
  label,
  value,
  kind,
  children,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly kind: 'radio' | 'checkbox';
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useDismiss(open, box, (reason) => (reason === 'escape' ? close() : setOpen(false)));

  return (
    <div ref={box} className="tm-wl-filter" data-set={value !== undefined || undefined}>
      <button
        ref={trigger}
        type="button"
        className="tm-wl-filter__trigger"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        // The name says what the filter is and what it is set to: "Project: Website relaunch".
        aria-label={value === undefined ? label : `${label}: ${value}`}
        onClick={() => setOpen((current) => !current)}
      >
        <bdi className="tm-wl-filter__label">{value ?? label}</bdi>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div id={id} className="tm-wl-filter__menu" data-kind={kind}>
          <fieldset className="tm-wl-filter__group">
            <legend className="tm-visually-hidden">{label}</legend>
            {children(close)}
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

function Choice({
  kind,
  name,
  checked,
  dot,
  onPick,
  children,
}: {
  readonly kind: 'radio' | 'checkbox';
  readonly name: string;
  readonly checked: boolean;
  readonly dot?: string;
  readonly onPick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <label className="tm-wl-choice">
      <input
        type={kind}
        name={name}
        checked={checked}
        onChange={onPick}
        // A radio already on fires no change; a press on it still closes the popover.
        {...(kind === 'radio' && checked ? { onClick: onPick } : {})}
      />
      {dot ? (
        <span className="tm-wl-choice__dot" style={{ background: dot }} aria-hidden="true" />
      ) : null}
      <span className="tm-wl-choice__text">{children}</span>
    </label>
  );
}
