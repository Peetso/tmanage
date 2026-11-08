'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import {
  addTimelineDependency,
  applyTimelineMove,
  getTimelineBaseline,
  getTimelineCriticalPath,
  getWorkTimeline,
  moveTimelineMilestone,
  previewTimelineMove,
  removeTimelineDependency,
} from '../../lib/api/work-views';
import type {
  TimelineMilestoneMoveInput,
  TimelineMoveInput,
  WorkTimelineMilestoneRow,
  WorkTimelineRow,
} from '../../lib/api/work-views';
import { ApiRequestError } from '../../lib/api/errors';
import {
  formatInstant,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { displayLocaleDirection } from '../../lib/i18n/direction';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  DAY,
  daysForTravel,
  milestoneMove,
  shiftSchedule,
  slipDays,
  stepForKey,
} from './work-timeline-edit';
import type { EditMode } from './work-timeline-edit';
import '../../styles/screens/work-planning.css';
import '../../styles/screens/work-timeline-edit.css';

export interface WorkTimelineScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Pre-select a project (deep link `?project=`). Defaults to the first project the caller sees. */
  initialProjectId?: string;
  client?: ApiClient;
  /** Injected in tests so "today" and "past due" are measured against a fixed moment. */
  now?: Date;
}

const MIN_WEEKS = 8;
const MAX_COLUMNS = 12;
/** A keyboard or button nudge saves once the keys go quiet — one write per gesture, not per press. */
const KEY_SAVE_DELAY_MS = 700;
/** How long the "Moved · Undo" chip stays (53-03 UX flow). */
const UNDO_WINDOW_MS = 6_000;

interface Draft {
  readonly id: string;
  readonly mode: EditMode;
  readonly days: number;
}

interface PendingMove {
  readonly id: string;
  readonly input: TimelineMoveInput;
  readonly previous: TimelineMoveInput;
  readonly expectedMoves: readonly string[];
  readonly count: number;
}

interface ReasonPrompt {
  readonly milestoneId: string;
  readonly move: TimelineMilestoneMoveInput;
}

/**
 * **WK-04 Timeline**, editable (53-03) — the Gantt from `TManage Screens - Work Extended.dc.html`
 * over the timeline read (`GET .../work-views/timeline/:projectId`), with the 53-04..07 writes.
 *
 * - Drag a bar to move it, drag either edge to resize it; the keyboard path is the same gesture:
 *   ←/→ a day, Shift a week, Alt the end (A11Y-05). A move previews the 53-04 cascade first and
 *   asks only when other tasks would move; a saved move offers "Undo" for a few seconds.
 * - Drag the dot at a bar's end onto another bar, or use "Link tasks", to draw a finish-to-start
 *   dependency; the schedule panel lists each edge with "Remove" and adds one from a list.
 * - "Baseline" draws the current baseline's dates as dashed ghost bars with the slip (53-05);
 *   "Critical path" marks critical bars and shows the slack of the rest (53-06). Phase bands and
 *   milestone diamonds come with the read (53-07); a diamond drags or steps like a bar.
 * - Right-to-left: the axis uses logical insets, so in Arabic time runs right to left, and a
 *   pointer or arrow key that goes "later" follows that axis.
 *
 * "Accessible list" swaps the chart for the same rows as a table.
 */
export function WorkTimelineScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
  now: nowProp,
}: WorkTimelineScreenProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const tOr = useTOr();
  const rtl = displayLocaleDirection(useActiveLocale()) === 'rtl';
  const queryClient = useQueryClient();
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [listView, setListView] = useState(false);
  const [showBaseline, setShowBaseline] = useState(false);
  const [showCritical, setShowCritical] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [milestoneDraft, setMilestoneDraft] = useState<{ id: string; days: number } | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [undo, setUndo] = useState<{ id: string; previous: TimelineMoveInput } | null>(null);
  const [reasonPrompt, setReasonPrompt] = useState<ReasonPrompt | null>(null);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [addPredecessor, setAddPredecessor] = useState('');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const milestoneRef = useRef<{ id: string; days: number } | null>(null);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // A timeline is per project: with none chosen, the first project the caller can see.
  const chosenProjectId = projectId !== '' ? projectId : (projects.data?.[0]?.id ?? '');
  const projectName = projects.data?.find((project) => project.id === chosenProjectId)?.name;

  const timelineKey = useMemo(
    () => ['work-timeline', organizationSlug, chosenProjectId],
    [organizationSlug, chosenProjectId],
  );
  const timeline = useQuery({
    queryKey: timelineKey,
    queryFn: () => getWorkTimeline(api, organizationSlug, chosenProjectId),
    enabled: chosenProjectId !== '',
  });
  const baseline = useQuery({
    queryKey: ['work-timeline-baseline', organizationSlug, chosenProjectId],
    queryFn: () => getTimelineBaseline(api, organizationSlug, chosenProjectId),
    enabled: showBaseline && chosenProjectId !== '',
  });
  const critical = useQuery({
    queryKey: ['work-timeline-critical', organizationSlug, chosenProjectId],
    queryFn: () => getTimelineCriticalPath(api, organizationSlug, chosenProjectId),
    enabled: showCritical && chosenProjectId !== '',
  });

  const rows = useMemo(() => timeline.data?.items ?? [], [timeline.data]);
  const milestones = useMemo(() => timeline.data?.milestones ?? [], [timeline.data]);
  const phases = useMemo(() => timeline.data?.phases ?? [], [timeline.data]);

  const titlesById = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) names.set(row.id, row.title);
    return names;
  }, [rows]);

  const baselineById = useMemo(() => {
    const map = new Map<string, { startAt: string | null; dueAt: string | null }>();
    for (const item of baseline.data?.items ?? []) map.set(item.workItemId, item);
    return map;
  }, [baseline.data]);

  // The critical-path read is recomputed when stale, so it wins over the timeline's stored copy.
  const scheduleById = useMemo(() => {
    const map = new Map<string, { critical: boolean; floatDays: number | null }>();
    for (const row of rows) {
      map.set(row.id, { critical: row.critical ?? false, floatDays: row.floatDays ?? null });
    }
    for (const item of critical.data?.items ?? []) {
      map.set(item.id, { critical: item.isCritical, floatDays: item.totalFloatDays });
    }
    return map;
  }, [rows, critical.data]);

  const chart = useMemo(
    () => buildChart(rows, milestones, [...baselineById.values()], now),
    [rows, milestones, baselineById, now],
  );
  const noProjects = projects.isSuccess && projects.data.length === 0;
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  useEffect(
    () => () => {
      if (keyTimer.current) clearTimeout(keyTimer.current);
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: timelineKey });
    if (showCritical) {
      await queryClient.invalidateQueries({
        queryKey: ['work-timeline-critical', organizationSlug, chosenProjectId],
      });
    }
  }, [queryClient, timelineKey, showCritical, organizationSlug, chosenProjectId]);

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiRequestError && error.status === 409) setConflict(true);
    else setSaveError(error);
  }, []);

  const offerUndo = useCallback((id: string, previous: TimelineMoveInput) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ id, previous });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_WINDOW_MS);
  }, []);

  /** Preview the cascade; save at once when nothing else moves, else ask (one confirmation). */
  const commitMove = useCallback(
    async (row: WorkTimelineRow, input: TimelineMoveInput) => {
      setSaveError(null);
      setConflict(false);
      const previous = { startAt: row.startAt, dueAt: row.dueAt };
      try {
        const plan = await previewTimelineMove(api, organizationSlug, row.id, input);
        const expectedMoves = plan.moves.map((move) => move.id);
        const count = plan.moves.length + plan.hiddenCount;
        if (count > 0) {
          setPending({ id: row.id, input, previous, expectedMoves, count });
          return;
        }
        await applyTimelineMove(api, organizationSlug, row.id, input, expectedMoves);
        offerUndo(row.id, previous);
      } catch (error) {
        fail(error);
      } finally {
        setDraft(null);
        await refresh();
      }
    },
    [api, organizationSlug, offerUndo, fail, refresh],
  );

  const applyPending = useCallback(async () => {
    if (!pending) return;
    setPending(null);
    try {
      await applyTimelineMove(
        api,
        organizationSlug,
        pending.id,
        pending.input,
        pending.expectedMoves,
      );
      offerUndo(pending.id, pending.previous);
    } catch (error) {
      fail(error);
    } finally {
      await refresh();
    }
  }, [api, organizationSlug, pending, offerUndo, fail, refresh]);

  const runUndo = useCallback(async () => {
    if (!undo) return;
    setUndo(null);
    try {
      const plan = await previewTimelineMove(api, organizationSlug, undo.id, undo.previous);
      await applyTimelineMove(
        api,
        organizationSlug,
        undo.id,
        undo.previous,
        plan.moves.map((move) => move.id),
      );
    } catch (error) {
      fail(error);
    } finally {
      await refresh();
    }
  }, [api, organizationSlug, undo, fail, refresh]);

  /** A keyboard or button step: accumulate, then save once the steps stop. */
  const nudge = useCallback(
    (row: WorkTimelineRow, mode: EditMode, days: number) => {
      if (row.startAt === null && row.dueAt === null) return;
      const current = draftRef.current;
      const total =
        current && current.id === row.id && current.mode === mode ? current.days + days : days;
      const next = { id: row.id, mode, days: total };
      draftRef.current = next;
      setDraft(next);
      if (keyTimer.current) clearTimeout(keyTimer.current);
      keyTimer.current = setTimeout(() => {
        draftRef.current = null;
        if (total !== 0) void commitMove(row, shiftSchedule(row, mode, total));
        else setDraft(null);
      }, KEY_SAVE_DELAY_MS);
    },
    [commitMove],
  );

  const link = useCallback(
    async (predecessorId: string, dependentId: string) => {
      if (predecessorId === dependentId) return;
      setSaveError(null);
      try {
        await addTimelineDependency(api, organizationSlug, dependentId, predecessorId);
      } catch (error) {
        fail(error);
      } finally {
        await refresh();
      }
    },
    [api, organizationSlug, fail, refresh],
  );

  const unlink = useCallback(
    async (dependentId: string, dependencyId: string) => {
      setSaveError(null);
      try {
        await removeTimelineDependency(api, organizationSlug, dependentId, dependencyId);
      } catch (error) {
        fail(error);
      } finally {
        await refresh();
      }
    },
    [api, organizationSlug, fail, refresh],
  );

  const saveMilestone = useCallback(
    async (milestoneId: string, move: TimelineMilestoneMoveInput) => {
      setSaveError(null);
      try {
        await moveTimelineMilestone(api, organizationSlug, chosenProjectId, milestoneId, move);
        setReasonPrompt(null);
        setReason('');
      } catch (error) {
        // A published date moving needs a client-safe reason: ask for it, then retry.
        if (error instanceof ApiRequestError && error.status === 422 && !move.clientSafeReason) {
          setReasonPrompt({ milestoneId, move });
        } else {
          fail(error);
        }
      } finally {
        setMilestoneDraft(null);
        await refresh();
      }
    },
    [api, organizationSlug, chosenProjectId, fail, refresh],
  );

  const nudgeMilestone = useCallback(
    (milestone: WorkTimelineMilestoneRow, days: number) => {
      const current = milestoneRef.current;
      const total = current && current.id === milestone.id ? current.days + days : days;
      milestoneRef.current = { id: milestone.id, days: total };
      setMilestoneDraft({ id: milestone.id, days: total });
      if (keyTimer.current) clearTimeout(keyTimer.current);
      keyTimer.current = setTimeout(() => {
        milestoneRef.current = null;
        const move = total === 0 ? null : milestoneMove(milestone, total);
        if (move) void saveMilestone(milestone.id, move);
        else setMilestoneDraft(null);
      }, KEY_SAVE_DELAY_MS);
    },
    [saveMilestone],
  );

  /** Pointer drag on a bar, an edge, or the link dot. A press without travel is a click. */
  const startBarDrag = (event: ReactPointerEvent<HTMLElement>, row: WorkTimelineRow) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const part = target.dataset['part'];
    const lane = event.currentTarget.closest('.wp-gantt__lane');
    const width = lane?.getBoundingClientRect().width ?? 0;
    const originX = event.clientX;
    const mode: EditMode = part === 'start' ? 'start' : part === 'end' ? 'end' : 'move';
    const linking = part === 'link';
    let days = 0;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const element = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      if (linking) return;
      days = daysForTravel(moveEvent.clientX - originX, width, chart.totalDays, rtl);
      setDraft(days === 0 ? null : { id: row.id, mode, days });
    };
    const up = (upEvent: PointerEvent) => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      if (linking) {
        const over = document
          .elementFromPoint(upEvent.clientX, upEvent.clientY)
          ?.closest<HTMLElement>('[data-bar-id]');
        const dependentId = over?.dataset['barId'];
        if (dependentId && dependentId !== row.id) void link(row.id, dependentId);
        return;
      }
      if (days !== 0 && (row.startAt !== null || row.dueAt !== null)) {
        void commitMove(row, shiftSchedule(row, mode, days));
      } else {
        selectBar(row.id);
      }
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };

  const startMilestoneDrag = (
    event: ReactPointerEvent<HTMLElement>,
    milestone: WorkTimelineMilestoneRow,
  ) => {
    if (event.button !== 0 || milestone.date === null) return;
    const width =
      event.currentTarget.closest('.wp-gantt__lane')?.getBoundingClientRect().width ?? 0;
    const originX = event.clientX;
    const element = event.currentTarget;
    let days = 0;
    element.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      days = daysForTravel(moveEvent.clientX - originX, width, chart.totalDays, rtl);
      setMilestoneDraft(days === 0 ? null : { id: milestone.id, days });
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      const change = days === 0 ? null : milestoneMove(milestone, days);
      if (change) void saveMilestone(milestone.id, change);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };

  function selectBar(id: string) {
    if (linkMode) {
      if (linkFrom === null) setLinkFrom(id);
      else {
        void link(linkFrom, id);
        setLinkFrom(null);
      }
      return;
    }
    setSelectedId(id);
    setAddPredecessor('');
  }

  const onBarKey = (event: ReactKeyboardEvent<HTMLElement>, row: WorkTimelineRow) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      void runUndo();
      return;
    }
    if (event.key === 'Escape') {
      if (keyTimer.current) clearTimeout(keyTimer.current);
      draftRef.current = null;
      setDraft(null);
      return;
    }
    const step = stepForKey(event.key, { shift: event.shiftKey, alt: event.altKey, rtl });
    if (!step) return;
    event.preventDefault();
    nudge(row, step.mode, step.days);
  };

  const onMilestoneKey = (
    event: ReactKeyboardEvent<HTMLElement>,
    milestone: WorkTimelineMilestoneRow,
  ) => {
    const step = stepForKey(event.key, { shift: event.shiftKey, alt: false, rtl });
    if (!step || milestone.date === null) return;
    event.preventDefault();
    nudgeMilestone(milestone, step.days);
  };

  const count = (key: string, english: string, value: number | string) =>
    tOr(key, english).replace('{count}', String(value));

  const toggle = (on: boolean, label: string, onClick: () => void) => (
    <button type="button" className="wp-capsule" aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('WorkTimelineScreen.title')}
      eyebrow={
        projectName
          ? `${projectName} · ${t('WorkTimelineScreen.timeline')}`
          : t('WorkTimelineScreen.timeline')
      }
      actions={
        <div className="wp-toolbar">
          <nav className="wp-segmented" aria-label={t('WorkTimelineScreen.workViews')}>
            <Link href={`/${organizationSlug}/work`}>{t('WorkTimelineScreen.list')}</Link>
            <span aria-current="page">{t('WorkTimelineScreen.timeline')}</span>
            <Link
              href={`/${organizationSlug}/work/calendar${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              {t('WorkTimelineScreen.calendar')}
            </Link>
            <Link
              href={`/${organizationSlug}/work/workload${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              {t('WorkTimelineScreen.workload')}
            </Link>
          </nav>
          <label className="tm-visually-hidden" htmlFor="tm-timeline-project">
            {t('WorkTimelineScreen.showTimelineFor')}
          </label>
          <select
            id="tm-timeline-project"
            className="wp-select"
            value={chosenProjectId}
            disabled={projects.isPending || noProjects}
            onChange={(event) => {
              setProjectId(event.target.value);
              setSelectedId(null);
            }}
          >
            {chosenProjectId === '' ? (
              <option value="">{t('WorkTimelineScreen.chooseProject')}</option>
            ) : null}
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {toggle(showBaseline, tOr('WorkTimelineScreen.baseline', 'Baseline'), () =>
            setShowBaseline((current) => !current),
          )}
          {toggle(showCritical, tOr('WorkTimelineScreen.criticalPath', 'Critical path'), () =>
            setShowCritical((current) => !current),
          )}
          {toggle(linkMode, tOr('WorkTimelineScreen.linkTasks', 'Link tasks'), () => {
            setLinkMode((current) => !current);
            setLinkFrom(null);
          })}
          {toggle(listView, t('WorkTimelineScreen.accessibleList'), () =>
            setListView((current) => !current),
          )}
        </div>
      }
    >
      {projects.isError ? (
        <InlineAlert tone="danger" title={t('WorkTimelineScreen.projectsError')} live>
          {describeError(projects.error)}
        </InlineAlert>
      ) : null}

      {noProjects ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkTimelineScreen.noProjectTitle')}</h2>
          <p className="wp-empty__body">{t('WorkTimelineScreen.noProjectBody')}</p>
        </div>
      ) : null}

      {timeline.isError ? (
        <InlineAlert tone="danger" title={t('WorkTimelineScreen.timelineError')} live>
          {describeError(timeline.error)}
        </InlineAlert>
      ) : null}

      {conflict ? (
        <InlineAlert
          tone="warning"
          title={tOr(
            'WorkTimelineScreen.conflict',
            'Someone else changed this plan. Reload to see their change.',
          )}
          live
        >
          <button
            type="button"
            className="wp-capsule"
            onClick={() => {
              setConflict(false);
              void refresh();
            }}
          >
            {tOr('WorkTimelineScreen.reload', 'Reload')}
          </button>
        </InlineAlert>
      ) : null}

      {saveError ? (
        <InlineAlert
          tone="danger"
          title={tOr('WorkTimelineScreen.saveError', 'Could not save the change')}
          live
        >
          {describeError(saveError)}
        </InlineAlert>
      ) : null}

      {showBaseline && baseline.isSuccess && baseline.data === null ? (
        <InlineAlert tone="neutral">
          {tOr(
            'WorkTimelineScreen.noBaseline',
            "No current baseline yet. Set one from the project's baselines.",
          )}
        </InlineAlert>
      ) : null}

      {linkMode ? (
        <p className="wte-hint" role="status">
          {linkFrom === null
            ? tOr(
                'WorkTimelineScreen.linkHint',
                'Pick the task that comes first, then the task that waits for it.',
              )
            : tOr(
                'WorkTimelineScreen.linkPicked',
                'Now pick the task that waits for “{title}”.',
              ).replace('{title}', titlesById.get(linkFrom) ?? '')}
        </p>
      ) : null}

      {chosenProjectId !== '' && timeline.isPending ? (
        <LoadingRegion label={t('WorkTimelineScreen.loading')}>
          <Skeleton height="38px" />
          <Skeleton height="40px" />
          <Skeleton height="40px" />
          <Skeleton height="40px" />
        </LoadingRegion>
      ) : null}

      {chosenProjectId !== '' && timeline.isSuccess && rows.length === 0 ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkTimelineScreen.emptyTitle')}</h2>
          <p className="wp-empty__body">{t('WorkTimelineScreen.emptyBody')}</p>
        </div>
      ) : null}

      {rows.length > 0 && !listView ? (
        <div className="wp-gantt">
          <div
            className="wp-gantt__scroll"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={t('WorkTimelineScreen.chartRegion')}
          >
            <div className="wp-gantt__inner">
              <div className="wp-gantt__head" aria-hidden="true">
                <div className="wp-gantt__label wp-mono-label">
                  {t('WorkTimelineScreen.workLabel')}
                </div>
                <div className="wp-gantt__weeks">
                  {chart.columns.map((column) => (
                    <div
                      key={column.key}
                      className={`wp-gantt__week${column.current ? ' wp-gantt__week--now' : ''}`}
                    >
                      {column.label}
                    </div>
                  ))}
                </div>
              </div>

              {phases.length > 0 ? (
                <div className="wp-gantt__row wte-row--layer">
                  <div className="wp-gantt__label wte-layer-label">
                    {tOr('WorkTimelineScreen.phases', 'Phases')}
                  </div>
                  <div className="wp-gantt__lane">
                    {phases.map((phase) => {
                      const extent = chart.extent(phase.startsOn, phase.endsOn);
                      if (!extent) return null;
                      return (
                        <span
                          key={phase.id}
                          className="wte-phase"
                          style={{
                            insetInlineStart: `${extent.start}%`,
                            inlineSize: `${Math.max(extent.end - extent.start, 1)}%`,
                          }}
                        >
                          {phase.name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {milestones.length > 0 ? (
                <div className="wp-gantt__row wte-row--layer">
                  <div className="wp-gantt__label wte-layer-label">
                    {tOr('WorkTimelineScreen.milestones', 'Milestones')}
                  </div>
                  <div className="wp-gantt__lane">
                    {milestones.map((milestone) => {
                      if (milestone.date === null) return null;
                      const shift = milestoneDraft?.id === milestone.id ? milestoneDraft.days : 0;
                      const day =
                        Date.parse(`${milestone.date.slice(0, 10)}T00:00:00Z`) + shift * DAY;
                      const label = new Date(day).toISOString();
                      return (
                        <button
                          key={milestone.id}
                          type="button"
                          className={`wte-diamond${shift !== 0 ? ' wte-diamond--moving' : ''}`}
                          style={{ insetInlineStart: `${chart.percent(day + DAY / 2)}%` }}
                          aria-label={tOr(
                            'WorkTimelineScreen.milestoneLabel',
                            '{title}, {date}. Arrow keys move it.',
                          )
                            .replace('{title}', milestone.title)
                            .replace('{date}', formatInstant(label))}
                          title={`${milestone.title} · ${formatInstant(label)}`}
                          onPointerDown={(event) => startMilestoneDrag(event, milestone)}
                          onKeyDown={(event) => onMilestoneKey(event, milestone)}
                        >
                          <span className="wte-diamond__name">{milestone.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {rows.map((row) => {
                const live =
                  draft?.id === row.id ? shiftSchedule(row, draft.mode, draft.days) : row;
                const bar = chart.extent(live.startAt, live.dueAt);
                const late = bar ? isOverdue(row, now) : false;
                const schedule = scheduleById.get(row.id);
                const ghost = showBaseline ? baselineById.get(row.id) : undefined;
                const ghostBar = ghost ? chart.extent(ghost.startAt, ghost.dueAt) : null;
                const slip = ghost ? slipDays(ghost.dueAt, row.dueAt) : null;
                const isCritical = showCritical && schedule?.critical === true;
                const slack = showCritical && !isCritical ? (schedule?.floatDays ?? null) : null;
                return (
                  <div
                    key={row.id}
                    className={`wp-gantt__row${selectedId === row.id ? ' wte-row--selected' : ''}`}
                  >
                    <div className="wp-gantt__label">
                      <Link
                        className="wp-gantt__title"
                        href={`/${organizationSlug}/work/${row.id}`}
                      >
                        {row.title}
                      </Link>
                    </div>
                    <div className="wp-gantt__lane">
                      {chart.today !== null ? (
                        <span
                          className="wp-gantt__today"
                          style={{ insetInlineStart: `${chart.today}%` }}
                          aria-hidden="true"
                        />
                      ) : null}
                      {row.predecessorIds.map((id) => {
                        const before = chart.bars.get(id);
                        if (!bar || !before || before.end >= bar.start) return null;
                        return (
                          <span
                            key={id}
                            className={`wp-gantt__dep${isCritical ? ' wte-dep--critical' : ''}`}
                            style={{
                              insetInlineStart: `${before.end}%`,
                              inlineSize: `${bar.start - before.end}%`,
                            }}
                            aria-hidden="true"
                          />
                        );
                      })}
                      {ghostBar ? (
                        <span
                          className="wte-ghost"
                          style={{
                            insetInlineStart: `${ghostBar.start}%`,
                            inlineSize: `${Math.max(ghostBar.end - ghostBar.start, 1)}%`,
                          }}
                          aria-hidden="true"
                        />
                      ) : null}
                      {bar ? (
                        <>
                          <button
                            type="button"
                            data-bar-id={row.id}
                            className={[
                              'wp-gantt__bar',
                              'wte-bar',
                              barClass(row, late),
                              isCritical ? 'wte-bar--critical' : '',
                              draft?.id === row.id ? 'wte-bar--moving' : '',
                              linkFrom === row.id ? 'wte-bar--link-from' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            style={{
                              insetInlineStart: `${bar.start}%`,
                              inlineSize: `${Math.max(bar.end - bar.start, 1)}%`,
                            }}
                            aria-label={tOr(
                              'WorkTimelineScreen.barLabel',
                              '{title}, {from} to {to}. Arrow keys move it, Alt with arrows changes the end.',
                            )
                              .replace('{title}', row.title)
                              .replace('{from}', formatInstant(live.startAt))
                              .replace('{to}', formatInstant(live.dueAt))}
                            aria-pressed={selectedId === row.id}
                            title={`${stateLabel(row.state)} · ${formatInstant(live.startAt)} → ${formatInstant(live.dueAt)}`}
                            onPointerDown={(event) => startBarDrag(event, row)}
                            onKeyDown={(event) => onBarKey(event, row)}
                            onClick={(event) => {
                              // A pointer click is handled on pointer-up; this is Enter/Space.
                              if (event.detail === 0) selectBar(row.id);
                            }}
                          >
                            <span
                              className="wte-edge wte-edge--start"
                              data-part="start"
                              aria-hidden="true"
                            />
                            <span
                              className="wte-edge wte-edge--end"
                              data-part="end"
                              aria-hidden="true"
                            />
                            <span className="wte-link-dot" data-part="link" aria-hidden="true" />
                          </button>
                          {draft?.id === row.id ? (
                            <span
                              className="wte-badge"
                              style={{ insetInlineStart: `${bar.start}%` }}
                              aria-live="polite"
                            >
                              {formatInstant(live.startAt)} → {formatInstant(live.dueAt)}
                            </span>
                          ) : null}
                          {late && row.dueAt !== null ? (
                            <span
                              className="wp-gantt__late"
                              style={{ insetInlineStart: `${bar.end}%` }}
                            >
                              +
                              {Math.max(
                                1,
                                Math.round((now.getTime() - Date.parse(row.dueAt)) / DAY),
                              )}
                              D
                            </span>
                          ) : slip !== null && slip > 0 ? (
                            <span
                              className="wp-gantt__late"
                              style={{ insetInlineStart: `${bar.end}%` }}
                            >
                              {count(
                                'WorkTimelineScreen.vsBaseline',
                                '+{count} d vs baseline',
                                slip,
                              )}
                            </span>
                          ) : slack !== null && slack > 0 ? (
                            <span className="wte-slack" style={{ insetInlineStart: `${bar.end}%` }}>
                              {count('WorkTimelineScreen.slack', '{count} d slack', slack)}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span
                          className="wp-gantt__bar wp-gantt__bar--undated"
                          style={{ insetInlineStart: '0%', inlineSize: '12%' }}
                          title={t('WorkTimelineScreen.undated')}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="wp-gantt__foot">
            <span>
              {tOr(
                'WorkTimelineScreen.legendEdit',
                'Solid ink = done · Ink outline = scheduled · Orange outline = past due · Orange edge = critical · Dashed outline = baseline · Diamond = milestone',
              )}
            </span>
            <span>{t('WorkTimelineScreen.legendList')}</span>
          </div>
        </div>
      ) : null}

      {pending || undo ? (
        <div className="wte-actions">
          {pending ? (
            <div className="wte-cascade" role="alertdialog" aria-live="assertive">
              <span>
                {count(
                  'WorkTimelineScreen.cascade',
                  'This will move {count} more tasks',
                  pending.count,
                )}
              </span>
              <button
                type="button"
                className="wte-button wte-button--ink"
                onClick={() => void applyPending()}
              >
                {tOr('WorkTimelineScreen.apply', 'Apply')}
              </button>
              <button type="button" className="wte-button" onClick={() => setPending(null)}>
                {tOr('WorkTimelineScreen.cancel', 'Cancel')}
              </button>
            </div>
          ) : null}
          {undo ? (
            <div className="wte-undo" role="status">
              <span>{tOr('WorkTimelineScreen.moved', 'Moved')}</span>
              <button type="button" className="wte-button" onClick={() => void runUndo()}>
                {tOr('WorkTimelineScreen.undo', 'Undo')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {reasonPrompt ? (
        <form
          className="wte-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() === '') return;
            void saveMilestone(reasonPrompt.milestoneId, {
              ...reasonPrompt.move,
              clientSafeReason: reason.trim(),
            });
          }}
        >
          <label className="wte-panel__hint" htmlFor="tm-timeline-reason">
            {tOr(
              'WorkTimelineScreen.reasonLabel',
              'Say why the date moved — the client will see it',
            )}
          </label>
          <div className="wte-panel__row">
            <input
              id="tm-timeline-reason"
              className="wp-select"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
            <button type="submit" className="wte-button wte-button--ink">
              {tOr('WorkTimelineScreen.save', 'Save')}
            </button>
            <button type="button" className="wte-button" onClick={() => setReasonPrompt(null)}>
              {tOr('WorkTimelineScreen.cancel', 'Cancel')}
            </button>
          </div>
        </form>
      ) : null}

      {selected && !listView ? (
        <section className="wte-panel" aria-labelledby="tm-timeline-schedule-title">
          <div className="wte-panel__row wte-panel__row--spread">
            <h2 id="tm-timeline-schedule-title" className="wte-panel__title">
              {tOr('WorkTimelineScreen.scheduleTitle', 'Schedule')} · {selected.title}
            </h2>
            <button type="button" className="wte-button" onClick={() => setSelectedId(null)}>
              {tOr('WorkTimelineScreen.close', 'Close')}
            </button>
          </div>
          <p className="wte-panel__hint">
            {tOr(
              'WorkTimelineScreen.keyboardHint',
              'Arrow keys move the bar by a day, Shift by a week, Alt changes the end. It saves when you stop.',
            )}
          </p>
          <div className="wte-panel__row">
            {(
              [
                ['move', -1, 'WorkTimelineScreen.dayEarlier', 'A day earlier'],
                ['move', 1, 'WorkTimelineScreen.dayLater', 'A day later'],
                ['end', -1, 'WorkTimelineScreen.endSooner', 'End a day sooner'],
                ['end', 1, 'WorkTimelineScreen.endLater', 'End a day later'],
              ] as const
            ).map(([mode, days, key, english]) => (
              <button
                key={key}
                type="button"
                className="wte-button"
                disabled={selected.startAt === null && selected.dueAt === null}
                onClick={() => nudge(selected, mode, days)}
              >
                {tOr(key, english)}
              </button>
            ))}
          </div>
          <h3 className="wte-panel__subtitle">{t('WorkTimelineScreen.colDependsOn')}</h3>
          {(selected.dependencies ?? []).length === 0 ? (
            <p className="wte-panel__hint">
              {tOr('WorkTimelineScreen.noDependencies', 'Waits on nothing')}
            </p>
          ) : (
            <ul className="wte-deps">
              {(selected.dependencies ?? []).map((dependency) => (
                <li key={dependency.id} className="wte-panel__row">
                  <span>
                    {titlesById.get(dependency.predecessorId) ??
                      tOr('WorkTimelineScreen.hiddenTask', 'A task in another project')}
                  </span>
                  <button
                    type="button"
                    className="wte-button"
                    onClick={() => void unlink(selected.id, dependency.id)}
                  >
                    {tOr('WorkTimelineScreen.remove', 'Remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="wte-panel__row"
            onSubmit={(event) => {
              event.preventDefault();
              if (addPredecessor === '') return;
              void link(addPredecessor, selected.id);
              setAddPredecessor('');
            }}
          >
            <label htmlFor="tm-timeline-add-dependency">
              {tOr('WorkTimelineScreen.addDependency', 'Add a dependency')}
            </label>
            <select
              id="tm-timeline-add-dependency"
              className="wp-select"
              value={addPredecessor}
              onChange={(event) => setAddPredecessor(event.target.value)}
            >
              <option value="">{tOr('WorkTimelineScreen.chooseTask', 'Choose a task…')}</option>
              {rows
                .filter(
                  (row) => row.id !== selected.id && !selected.predecessorIds.includes(row.id),
                )
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.title}
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className="wte-button wte-button--ink"
              disabled={addPredecessor === ''}
            >
              {tOr('WorkTimelineScreen.add', 'Add')}
            </button>
          </form>
        </section>
      ) : null}

      {rows.length > 0 && listView ? (
        <div
          className="wp-rows"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={t('WorkTimelineScreen.listRegion')}
        >
          <table>
            <caption className="tm-visually-hidden">
              {t('WorkTimelineScreen.captionPre')} {rows.length}{' '}
              {t('WorkTimelineScreen.captionShown')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('WorkTimelineScreen.colTitle')}</th>
                <th scope="col">{t('WorkTimelineScreen.colState')}</th>
                <th scope="col">{t('WorkTimelineScreen.colStart')}</th>
                <th scope="col">{t('WorkTimelineScreen.colDue')}</th>
                <th scope="col">{t('WorkTimelineScreen.colDependsOn')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    <Link className="wp-row-title" href={`/${organizationSlug}/work/${item.id}`}>
                      {item.title}
                    </Link>
                  </th>
                  <td>
                    <StateCapsule state={stateCapsule(item.state)}>
                      {stateLabel(item.state)}
                    </StateCapsule>
                  </td>
                  <td>
                    <span className="wp-row-mono">{formatInstant(item.startAt)}</span>
                  </td>
                  <td>
                    <span
                      className={
                        isOverdue(item, now) ? 'wp-row-mono wp-row-mono--warn' : 'wp-row-mono'
                      }
                    >
                      {formatInstant(item.dueAt)}
                    </span>
                  </td>
                  <td>{dependsOnLabel(item, titlesById)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppShell>
  );
}

function barClass(row: WorkTimelineRow, late: boolean): string {
  if (row.state === 'done') return '';
  if (late) return 'wp-gantt__bar--late';
  return 'wp-gantt__bar--open';
}

interface Extent {
  readonly start: number;
  readonly end: number;
}

interface Chart {
  readonly columns: readonly { key: string; label: string; current: boolean }[];
  /** Bar extents as percentages of the lane, keyed by work item id. */
  readonly bars: ReadonlyMap<string, Extent>;
  /** Where today falls, as a percentage, or `null` when it is outside the range. */
  readonly today: number | null;
  /** Days the lane spans — a pointer's travel converts to days through it. */
  readonly totalDays: number;
  /** A time as a percentage of the lane. */
  readonly percent: (time: number) => number;
  /** A start/end pair (instants or days) as a bar extent, or `null` when both are missing. */
  readonly extent: (from: string | null, to: string | null) => Extent | null;
}

function spanOf(from: string | null, to: string | null): { from: number; to: number } | null {
  const start = from === null ? Number.NaN : Date.parse(from);
  const due = to === null ? Number.NaN : Date.parse(to);
  const a = Number.isNaN(start) ? due : start;
  const b = Number.isNaN(due) ? start : due;
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * Weekly columns (Monday first) spanning every dated row, milestone and baseline date, and each
 * row's bar within them. The range is fixed by the stored dates, so a bar being dragged moves
 * against a still axis.
 */
function buildChart(
  rows: readonly WorkTimelineRow[],
  milestones: readonly WorkTimelineMilestoneRow[],
  baseline: readonly { startAt: string | null; dueAt: string | null }[],
  now: Date,
): Chart {
  const spans = new Map<string, { from: number; to: number }>();
  for (const row of rows) {
    const span = spanOf(row.startAt, row.dueAt);
    if (span) spans.set(row.id, span);
  }
  const extra = [
    ...milestones.map((milestone) => spanOf(milestone.date, milestone.date)),
    ...baseline.map((item) => spanOf(item.startAt, item.dueAt)),
  ].filter((span): span is { from: number; to: number } => span !== null);

  const values = [...spans.values(), ...extra];
  const earliest = values.length > 0 ? Math.min(...values.map((span) => span.from)) : now.getTime();
  const latest = values.length > 0 ? Math.max(...values.map((span) => span.to)) : now.getTime();

  const first = new Date(earliest);
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const weeks = Math.max(MIN_WEEKS, Math.ceil((latest + DAY - first.getTime()) / (7 * DAY)));
  const step = Math.ceil(weeks / MAX_COLUMNS);
  const count = Math.ceil(weeks / step);
  const rangeStart = first.getTime();
  const rangeEnd = rangeStart + count * step * 7 * DAY;
  const total = rangeEnd - rangeStart;
  const percent = (time: number) => ((time - rangeStart) / total) * 100;

  const columns = Array.from({ length: count }, (_, index) => {
    const start = rangeStart + index * step * 7 * DAY;
    const date = new Date(start);
    return {
      key: String(start),
      label: date
        .toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' })
        .split(' ')
        .reverse()
        .join(' '),
      current: now.getTime() >= start && now.getTime() < start + step * 7 * DAY,
    };
  });

  const bars = new Map<string, Extent>();
  for (const [id, span] of spans) {
    bars.set(id, { start: percent(span.from), end: percent(span.to + DAY) });
  }

  const today =
    now.getTime() >= rangeStart && now.getTime() < rangeEnd ? percent(now.getTime()) : null;
  const extent = (from: string | null, to: string | null): Extent | null => {
    const span = spanOf(from, to);
    return span ? { start: percent(span.from), end: percent(span.to + DAY) } : null;
  };
  return { columns, bars, today, totalDays: total / DAY, percent, extent };
}

function dependsOnLabel(row: WorkTimelineRow, titlesById: ReadonlyMap<string, string>): string {
  if (row.predecessorIds.length === 0) return '—';
  return row.predecessorIds.map((id) => titlesById.get(id) ?? id).join(', ');
}
