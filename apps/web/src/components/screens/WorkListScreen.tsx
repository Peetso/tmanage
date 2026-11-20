'use client';

import { Fragment, useEffect, useMemo, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { WorkViewsShell, WORK_STATE_VIEWS, sameStates } from '../work/WorkViewsShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listWorkItems, MAX_WORK_ITEM_PAGE, updateWorkItem } from '../../lib/api/work-items';
import type { WorkItemAudience, WorkItemSummary } from '../../lib/api/work-items';
import { workItemKeys } from '../../lib/query-keys';
import { projectWorkTopic, useWorkLiveRefresh } from '../../lib/use-work-live-refresh';
import {
  audienceLabel,
  formatInstant,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
import { typeCode, typeName } from '../../lib/work-item-type';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { activeIsEnglish, compactUnit } from '../../lib/i18n/compact-time';
import { withNumerals } from '../../lib/i18n/display-format';
import { appLocale } from '../../lib/i18n/app-locale';
import { countNoun } from '../../lib/i18n/plural';
import { useT } from '../../lib/i18n/use-t';
import { WorkBoardView } from './WorkBoardView';
import { ApiRequestError } from '../../lib/api/errors';
import { byRank, rankForDrop, useWorkDragPermissions } from '../../lib/work-drag';
import { CoachMarkTour } from '../help/CoachMarkTour';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { useTOr } from '../../lib/i18n/use-t-or';
import { PhoneWorkOverview } from '../phone/PhoneWorkOverview';
import { DoerStack } from '../work/WorkPeopleBlock';
import { useViewPreference } from '../views/use-view-preference';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useUndoEntries } from '../../lib/undo/use-undo';
import { heldKeys, undoKey } from '../../lib/undo/undo-queue';

/** 53-01: the most project topics one list view follows live. */
const LIVE_PROJECT_LIMIT = 50;

export interface WorkListScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how the project overview hands off to the full list. */
  initialProjectId?: string;
  client?: ApiClient;
  /** Injected in tests so the overdue rule can be exercised without waiting for a date. */
  now?: Date;
  /** A6: open on the board rather than the list. */
  initialView?: 'list' | 'board';
  /** The state filter to open on (`?state=` in the URL), so a reload keeps it. */
  initialStates?: readonly WorkItemState[];
}

/**
 * The list's view, project and state filter as a query string (2026-10-31 live test: a reload
 * dropped the filter and always came back to the list). Defaults are left out, so the plain
 * `/work` address stays plain.
 */
export function workListQuery(input: {
  readonly view: 'list' | 'board';
  readonly projectId: string;
  readonly states: readonly WorkItemState[];
}): string {
  const params = new URLSearchParams();
  if (input.projectId !== '') params.set('project', input.projectId);
  if (input.states.length > 0) params.set('state', [...input.states].join(','));
  if (input.view === 'board') params.set('view', 'board');
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The `?state=` value, kept to states the lifecycle defines. */
export function parseStateParam(value: string | null): readonly WorkItemState[] {
  if (value === null) return [];
  return value
    .split(',')
    .filter((entry): entry is WorkItemState =>
      (WORK_ITEM_STATES as readonly string[]).includes(entry),
    );
}

type SortKey = 'loaded' | 'title' | 'state' | 'due';
type SortDirection = 'asc' | 'desc';

/** §5's state order, so sorting by state groups the lifecycle rather than the alphabet. */
const STATE_ORDER: readonly WorkItemState[] = WORK_ITEM_STATES;

/**
 * **TM-10 Work list.**
 *
 * `22-SCREEN-BY-SCREEN` §5: "Columns: type, title, state, owner, priority, due, blocker,
 * audience. Saved views and filters. Table supports keyboard row navigation, selection,
 * sorting, bulk actions with policy preview."
 *
 * ## What this renders, and what it cannot
 *
 * Six of the eight columns exist as data: type, title, state, owner, due and audience. Two do
 * not, and are not drawn:
 *
 * - **Priority.** There is no priority column on `work_items` and none in `23-ERD` §5. A
 *   column showing "Normal" for every row would be a fiction that people would then sort by.
 * - **Blocker.** The blocker *reason* is supplied as a transition fact and is not stored as a
 *   field, so there is nothing to put in the cell. The `Blocked` state capsule is shown, which
 *   is the part that is real.
 *
 * ## Paging, sorting, selection — the second half of WEB-002, and where each rule lives
 *
 * - **Paging is the API's `after` cursor.** A full page means there may be more, and "Load
 *   more" appends the next page. The filters stay on the server; only the *pages* accumulate
 *   here.
 * - **Sorting is over the loaded rows, and says so.** The API offers no sort parameter, so a
 *   header sorts what has been loaded; while more pages exist the partial-list notice stays
 *   visible above the table, which keeps "sorted" from silently meaning "sorted some of it".
 *   State sorts in lifecycle order, not alphabetically — `blocked` before `done` is a
 *   judgement §5's state machine already made.
 * - **Bulk audience change is the one bulk action, and widening previews before it sends.**
 *   `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` makes audience the control that decides what
 *   a client can ever see; a bulk widening is the click that can disclose a dozen items at
 *   once, so the confirmation lists, by title, exactly the items whose audience will change —
 *   §5's "policy preview" as a list of consequences rather than a yes/no. Narrowing applies
 *   without ceremony, for the reason the detail screen gives: nothing new escapes.
 *   Each item is updated with the version this screen read; a `409` is reported by title and
 *   **never retried** — a bulk retry with fresh versions would be the lost update the token
 *   exists to prevent, multiplied.
 *
 * **Saved views are still absent, and now for a stated reason rather than a deadline**: there
 * is no server-side home for them (`28-SPRINT-TICKETS` schedules none), and browser storage
 * is barred from holding authoritative state by the workspace lint rule
 * (15-AI-EXECUTION-HANDBOOK §8). A saved view that lived in one browser would be a view that
 * lies about existing when its owner signs in anywhere else.
 */
export function WorkListScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
  now = new Date(),
  initialView,
  initialStates = [],
}: WorkListScreenProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  // R38 G5-views: a `?view=` in the address wins; otherwise the last view chosen on this page.
  const [view, setView] = useViewPreference<'list' | 'board'>(
    `work:${organizationSlug}`,
    LOCAL_WORK_VIEWS,
    'list',
    initialView,
  );
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const queries = useQueryClient();

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [states, setStates] = useState<readonly WorkItemState[]>(initialStates);
  const [sortKey, setSortKey] = useState<SortKey>('loaded');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  // FIX3 item C: a row dragged to a new place shows there at once (its new rank), until the
  // list is re-read; a refused move is rolled back with `reorderError`.
  const [rankOverrides, setRankOverrides] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [reorderError, setReorderError] = useState<{ title: string; reason: string } | null>(null);
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const dragRights = useWorkDragPermissions(api, organizationSlug);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<WorkItemAudience | undefined>(undefined);
  const [bulkReport, setBulkReport] = useState<
    // Keyed by id when listed: two work items may share a title (live 2026-11-01: two "QA09 …"
    // rows), and a title key collides as soon as both are refused.
    | { updated: number; failed: readonly { id: string; title: string; reason: string }[] }
    | undefined
  >(undefined);

  // The address follows the view and the filters, so a reload or a shared link reopens them.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = `${window.location.pathname}${workListQuery({ view, projectId, states })}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [view, projectId, states]);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // 53-01: the list and the board refetch when work in the shown project(s) changes elsewhere.
  // Every project (bounded) when none is picked, so the "all work" view stays live too.
  const liveTopics = useMemo(
    () =>
      projectId !== ''
        ? [projectWorkTopic(projectId)]
        : (projects.data ?? []).slice(0, LIVE_PROJECT_LIMIT).map((p) => projectWorkTopic(p.id)),
    [projectId, projects.data],
  );
  useWorkLiveRefresh({
    api,
    organizationSlug,
    topics: liveTopics,
    // A suite injects its own client and drives no socket; the live layer is the browser's.
    enabled: client === undefined,
    onChange: () =>
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) }),
  });

  // D16. One directory for every row's owner, resolved through one map rather than a fetch per
  // row; the same list the detail screen's picker offers, so a name never disagrees with itself.
  const directory = useMembers(api, organizationSlug);

  /*
   * The filters are part of the key, so changing one is a new query rather than a mutation of
   * the old one — the previous result stays on screen while the next loads. Pages accumulate
   * under the same key; the cursor is the last row's id, which is creation order.
   */
  const workItems = useInfiniteQuery({
    queryKey: workItemKeys.list(organizationSlug, projectId, states),
    queryFn: ({ pageParam }) =>
      listWorkItems(api, organizationSlug, {
        limit: MAX_WORK_ITEM_PAGE,
        ...(projectId === '' ? {} : { projectId }),
        ...(states.length === 0 ? {} : { states }),
        ...(pageParam === undefined ? {} : { after: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_WORK_ITEM_PAGE ? lastPage[lastPage.length - 1]?.id : undefined,
  });

  const bulkChange = useMutation({
    /*
     * Sequential on purpose: each item carries its own version, each refusal is its own
     * fact, and a parallel volley would make "which ones happened" a race to report.
     */
    mutationFn: async (input: {
      audience: WorkItemAudience;
      targets: readonly WorkItemSummary[];
    }) => {
      let updated = 0;
      const failed: { id: string; title: string; reason: string }[] = [];
      for (const item of input.targets) {
        try {
          await updateWorkItem(api, organizationSlug, item.id, {
            version: item.version,
            audience: input.audience,
          });
          updated += 1;
        } catch (error) {
          failed.push({ id: item.id, title: item.title, reason: describeError(error) });
        }
      }
      return { updated, failed };
    },
    onSuccess: (result) => {
      setBulkReport(result);
      setPendingBulk(undefined);
      setSelected(new Set());
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
    },
  });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);

  // 55-23: an item whose delete is held behind an Undo toast is already gone from the list.
  const heldUndo = useUndoEntries();
  const loadedRows = useMemo(() => {
    const held = heldKeys(heldUndo);
    return (workItems.data?.pages.flat() ?? []).filter((row) => !held.has(undoKey('work', row.id)));
  }, [workItems.data, heldUndo]);

  useEffect(() => {
    setRankOverrides(new Map());
  }, [loadedRows]);

  const rows = useMemo(() => {
    if (sortKey === 'loaded') {
      // The hand-made order: what people dragged, else when the item was made.
      return byRank(
        loadedRows.map((row) => {
          const rank = rankOverrides.get(row.id);
          return rank === undefined ? row : { ...row, rank };
        }),
      );
    }
    const sorted = [...loadedRows].sort((left, right) => compareBy(sortKey, left, right));
    if (sortDirection === 'desc') sorted.reverse();
    return sorted;
  }, [loadedRows, sortKey, sortDirection, rankOverrides]);

  const canReorder = dragRights.canUpdate && sortKey === 'loaded';

  /** Put `item` just before `beforeId` (or last) in the hand-made order; optimistic. */
  async function reorder(item: WorkItemSummary, beforeId: string | null) {
    const rank = rankForDrop(rows, item.id, beforeId);
    if (rank === null) return;
    setReorderError(null);
    setRankOverrides((current) => new Map(current).set(item.id, rank));
    try {
      await updateWorkItem(api, organizationSlug, item.id, { version: item.version, rank });
    } catch (error) {
      setRankOverrides((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
      setReorderError({
        title: item.title,
        reason:
          error instanceof ApiRequestError
            ? error.message
            : tOr('WorkBoard.moveFailed', 'Check your connection and try again.'),
      });
    } finally {
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
    }
  }

  /** The keyboard path: one place up or down. */
  function nudgeRow(item: WorkItemSummary, step: -1 | 1) {
    const index = rows.findIndex((row) => row.id === item.id);
    if (index === -1) return;
    if (step === -1 && index === 0) return;
    if (step === 1 && index === rows.length - 1) return;
    const beforeId = step === -1 ? (rows[index - 1]?.id ?? null) : (rows[index + 2]?.id ?? null);
    void reorder(item, beforeId);
  }

  const selectedRows = rows.filter((row) => selected.has(row.id));
  const allVisibleSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  function toggleState(state: WorkItemState) {
    setStates((current) =>
      current.includes(state) ? current.filter((value) => value !== state) : [...current, state],
    );
    setSelected(new Set());
  }

  function toggleSort(key: Exclude<SortKey, 'loaded'>) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDirection('asc');
    } else if (sortDirection === 'asc') {
      setSortDirection('desc');
    } else {
      setSortKey('loaded');
      setSortDirection('asc');
    }
  }

  function toggleRow(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startBulk(audience: WorkItemAudience) {
    setBulkReport(undefined);
    if (audience === 'internal') {
      // Narrowing is not confirmed — nothing new escapes. See the doc comment.
      bulkChange.mutate({ audience, targets: selectedRows });
      return;
    }
    setPendingBulk(audience);
  }

  const widening =
    pendingBulk === undefined ? [] : selectedRows.filter((row) => row.audience !== pendingBulk);

  const activeView = STATE_VIEWS.find((view) => sameStates(view.states, states));
  const blockedCount = loadedRows.filter((row) => row.state === 'blocked').length;
  const clientWaitingCount = loadedRows.filter(
    (row) => row.audience === 'client_action_required',
  ).length;
  const countLabel = `${localCount(loadedRows.length)}${workItems.hasNextPage ? '+' : ''}`;
  // CQ-07 (WRK-10): "1 items" reads wrong; a single loaded row with no further page is one item.
  const itemWord = workItems.hasNextPage
    ? t('WorkListScreen.itemPlural')
    : countNoun(
        appLocale(),
        loadedRows.length,
        t('WorkListScreen.itemSingular'),
        t('WorkListScreen.itemPlural'),
      );
  // CQ-07 (WRK-10): when the list is filtered to one project, name that project in the heading
  // rather than the state view's label ("All work"), which described the whole organization.
  const selectedProjectName = projectId === '' ? undefined : projectNames.get(projectId);

  /*
   * WK-02 groups the rows under a heading per milestone. Milestones are not on the list
   * response; the project is, so loaded order is grouped by project. A sorted list is flat —
   * a group heading in the middle of an order would cut the order in two.
   */
  const groups = useMemo(() => {
    if (sortKey !== 'loaded') return [{ key: 'all', label: undefined, rows }];
    const byProject = new Map<string, WorkItemSummary[]>();
    for (const row of rows) {
      const bucket = byProject.get(row.projectId);
      if (bucket) bucket.push(row);
      else byProject.set(row.projectId, [row]);
    }
    return [...byProject.entries()].map(([key, groupRows]) => ({
      key,
      label: projectNames.get(key) ?? t('WorkListScreen.anotherProject'),
      rows: groupRows,
    }));
  }, [rows, sortKey, projectNames, t]);

  function chooseStates(next: readonly WorkItemState[]) {
    setStates(next);
    setSelected(new Set());
  }

  function chooseProject(next: string) {
    setProjectId(next);
    setSelected(new Set());
  }

  return (
    <WorkViewsShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      {...(client ? { client } : {})}
      view={view}
      projectId={projectId}
      onChooseProject={chooseProject}
      states={states}
      onChooseStates={chooseStates}
      onLocalViewChange={setView}
      title={
        selectedProjectName ??
        (activeView ? t(activeView.labelKey) : t('WorkListScreen.filteredWork'))
      }
      titleMeta={
        view === 'board' || workItems.isPending
          ? undefined
          : `${countLabel} ${itemWord} · ${blockedCount} ${t('WorkListScreen.metaBlocked')} · ${clientWaitingCount} ${t('WorkListScreen.metaClientWaiting')}`
      }
    >
      {view === 'board' ? (
        <>
          {workItems.isError ? (
            <InlineAlert tone="danger" title={t('WorkListScreen.loadListError')} live>
              {describeError(workItems.error)}
            </InlineAlert>
          ) : null}
          {workItems.isPending ? (
            <LoadingRegion label={t('WorkListScreen.loadingList')}>
              <Skeleton height="120px" />
            </LoadingRegion>
          ) : (
            <WorkBoardView
              organizationSlug={organizationSlug}
              items={loadedRows}
              members={directory.members}
              membersPending={directory.isPending}
              now={now}
              api={api}
              dragRights={dragRights}
              onMoved={() =>
                void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) })
              }
            />
          )}
        </>
      ) : (
        <>
          {/* Phone (<768px) overview — the only list view drawn there (phone/work.css). */}
          <PhoneWorkOverview
            api={api}
            organizationSlug={organizationSlug}
            organizationName={organizationName}
            rows={loadedRows}
            projects={projects.data ?? []}
            now={now}
          />

          <section className="tm-wk-toolbar" aria-labelledby="tm-work-filters">
            <h2 id="tm-work-filters" className="tm-visually-hidden">
              {t('WorkListScreen.filters')}
            </h2>

            {/*
          Inert until the projects query has answered. Every filter here is a controlled input
          shipped in the server HTML, so a choice made before React hydrated was held only by
          the DOM: hydration re-applied `''` and an empty state list, the list below silently
          stayed unfiltered, and nothing said why. The gate is the projects query rather than
          `workItems`, which re-pends on every filter change and would lock the filters the
          moment one was used. `isError` means `isPending === false`, so a failed project list
          still leaves the state filters usable.
        */}
            <fieldset className="tm-wk-filters" disabled={projects.isPending}>
              <legend>{t('WorkListScreen.filters')}</legend>
              <span className="tm-wk-select">
                <label htmlFor="tm-work-project">{t('WorkListScreen.projectLabel')}</label>
                <select
                  id="tm-work-project"
                  value={projectId}
                  onChange={(event) => chooseProject(event.target.value)}
                >
                  <option value="">{t('WorkListScreen.allProjects')}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </span>

              <fieldset className="tm-wk-filters" aria-describedby="tm-work-state-hint">
                <legend>{t('WorkListScreen.stateLegend')}</legend>
                {WORK_ITEM_STATES.map((state) => (
                  <label
                    key={state}
                    className="tm-wk-filter"
                    {...(state === 'blocked' ? { 'data-tone': 'warning' } : {})}
                  >
                    <input
                      type="checkbox"
                      name="state"
                      value={state}
                      checked={states.includes(state)}
                      onChange={() => toggleState(state)}
                    />
                    {t(STATE_FILTER_LABEL[state])}
                  </label>
                ))}
              </fieldset>
            </fieldset>
            <span id="tm-work-state-hint" className="tm-visually-hidden">
              {t('WorkListScreen.stateHint')}
            </span>
          </section>

          {workItems.isError ? (
            <InlineAlert tone="danger" title={t('WorkListScreen.loadListError')} live>
              {describeError(workItems.error)}
            </InlineAlert>
          ) : null}

          {workItems.isPending ? (
            <LoadingRegion label={t('WorkListScreen.loadingList')}>
              <Skeleton height="38px" />
              <Skeleton height="38px" />
              <Skeleton height="38px" />
            </LoadingRegion>
          ) : null}

          {!workItems.isPending && !workItems.isError && rows.length === 0 ? (
            projectId === '' && states.length === 0 ? (
              <TeachingEmptyState
                title={t('WorkListScreen.emptyTitle')}
                explanation={t('WorkListScreen.emptyNoneOrg')}
                action={
                  <Link
                    className="tm-button tm-button--lime tm-button--compact"
                    href={`/${organizationSlug}/capture`}
                  >
                    {tOr('EmptyStates.newTask', 'New task')}
                  </Link>
                }
                helpSlug="create-and-assign-tasks"
                helpLabel={tOr('EmptyStates.howTasksWork', 'How tasks work')}
              />
            ) : (
              <InlineAlert tone="neutral" title={t('WorkListScreen.emptyTitle')}>
                {t('WorkListScreen.emptyNoMatch')}
              </InlineAlert>
            )
          ) : null}

          {reorderError ? (
            <InlineAlert
              tone="danger"
              title={tOr('WorkBoard.moveNotAllowed', 'Move not allowed')}
              live
            >
              {tOr('WorkBoard.moveNotAllowedBody', '“{title}” was not moved. {reason}')
                .replace('{title}', reorderError.title)
                .replace('{reason}', reorderError.reason)}
            </InlineAlert>
          ) : null}
          {bulkReport !== undefined ? (
            <InlineAlert
              tone={bulkReport.failed.length === 0 ? 'neutral' : 'warning'}
              title={`${t('WorkListScreen.audienceChangedPrefix')} ${bulkReport.updated} ${bulkReport.updated === 1 ? t('WorkListScreen.itemSingular') : t('WorkListScreen.itemPlural')}`}
              live
            >
              {bulkReport.failed.length > 0 ? (
                <>
                  <p className="tm-prose">
                    {t('WorkListScreen.bulkFailedPre')}{' '}
                    <strong>{t('WorkListScreen.bulkFailedNot')}</strong>{' '}
                    {t('WorkListScreen.bulkFailedPost')}
                  </p>
                  <ul className="tm-list">
                    {bulkReport.failed.map((failure) => (
                      <li key={failure.id}>
                        “{failure.title}” — {failure.reason}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </InlineAlert>
          ) : null}

          {selectedRows.length > 0 ? (
            <section className="tm-wk-bulk" aria-labelledby="tm-work-bulk">
              <span className="tm-wk-bulk__count" aria-hidden="true">
                {localCount(selectedRows.length)}
              </span>
              <h2 id="tm-work-bulk" className="tm-wk-bulk__label">
                <span className="tm-visually-hidden">{localCount(selectedRows.length)} </span>
                {t('WorkListScreen.selectedSetAudience')}
              </h2>
              <span className="tm-wk-bulk__rule" aria-hidden="true" />
              {(['internal', 'client_visible', 'client_action_required'] as const).map(
                (audience) => (
                  <button
                    key={audience}
                    type="button"
                    disabled={bulkChange.isPending}
                    onClick={() => startBulk(audience)}
                  >
                    {audienceLabel(audience)}
                  </button>
                ),
              )}
              <button
                type="button"
                className="tm-wk-bulk__close"
                aria-label={t('WorkListScreen.clearSelection')}
                onClick={() => {
                  setSelected(new Set());
                  setPendingBulk(undefined);
                }}
              >
                ✕
              </button>
            </section>
          ) : null}

          {selectedRows.length > 0 && pendingBulk !== undefined ? (
            <section className="tm-wk-review" role="status" aria-labelledby="tm-work-review">
              <h3 id="tm-work-review" className="tm-wk-review__title">
                {t('WorkListScreen.reviewTitle')}
              </h3>
              {widening.length === 0 ? (
                <p className="tm-wk-review__line">
                  <span className="tm-wk-review__mark" aria-hidden="true">
                    ✓
                  </span>
                  <span>
                    {t('WorkListScreen.reviewAlreadyPre')}{' '}
                    {audienceLabel(pendingBulk).toLowerCase()}{' '}
                    {t('WorkListScreen.reviewAlreadyPost')}
                  </span>
                </p>
              ) : (
                <div className="tm-wk-review__line">
                  <span className="tm-wk-review__mark" aria-hidden="true">
                    ✓
                  </span>
                  <div>
                    <p className="tm-prose">
                      {localCount(widening.length)} {t('WorkListScreen.reviewWideningOf')}{' '}
                      {localCount(selectedRows.length)} {t('WorkListScreen.reviewWideningSelected')}{' '}
                      {selectedRows.length === 1
                        ? t('WorkListScreen.itemSingular')
                        : t('WorkListScreen.itemPlural')}{' '}
                      {t('WorkListScreen.reviewWideningWillBecome')}{' '}
                      {audienceLabel(pendingBulk).toLowerCase()}{' '}
                      {t('WorkListScreen.reviewWideningPortal')}
                    </p>
                    <ul className="tm-wk-review__list">
                      {widening.map((row) => (
                        <li key={row.id}>“{row.title}”</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {widening.length > 0 && widening.length < selectedRows.length ? (
                <p className="tm-wk-review__line" data-tone="warning">
                  <span className="tm-wk-review__mark" aria-hidden="true">
                    !
                  </span>
                  <span>
                    {localCount(selectedRows.length - widening.length)}{' '}
                    {t('WorkListScreen.reviewPartialAlready')}{' '}
                    {audienceLabel(pendingBulk).toLowerCase()}{' '}
                    {t('WorkListScreen.reviewPartialLeft')}
                  </span>
                </p>
              ) : null}
              <div className="tm-wk-review__actions">
                {widening.length > 0 ? (
                  <Button
                    tone="ink"
                    size="accessible"
                    loading={bulkChange.isPending}
                    loadingLabel={t('WorkListScreen.publishing')}
                    onClick={() => bulkChange.mutate({ audience: pendingBulk, targets: widening })}
                  >
                    {t('WorkListScreen.showPrefix')}{' '}
                    {widening.length === 1
                      ? t('WorkListScreen.showIt')
                      : t('WorkListScreen.showThem')}{' '}
                    {t('WorkListScreen.showToClient')}
                  </Button>
                ) : null}
                <Button tone="outline" size="accessible" onClick={() => setPendingBulk(undefined)}>
                  {t('WorkListScreen.keepAsIs')}
                </Button>
                <span className="tm-wk-review__receipt">{t('WorkListScreen.keepsVersion')}</span>
              </div>
            </section>
          ) : null}

          {rows.length > 0 ? (
            <div className="tm-wk-table-frame">
              <div
                className="tm-table-scroll"
                // A scrollable region must be focusable or a keyboard cannot reach its overflow
                // columns (WCAG 2.2 2.1.1); the .tm-table-scroll CSS comment states the same.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                role="region"
                aria-label={t('WorkListScreen.tableRegion')}
              >
                <table className="tm-wk-table">
                  <caption className="tm-visually-hidden">
                    {t('WorkListScreen.colCaption')}
                    {projectId === '' ? '' : ` ${t('WorkListScreen.colCaptionInProject')}`}
                    {listComma()} {localCount(rows.length)} {t('WorkListScreen.shown')}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="tm-wk-cell--check">
                        <input
                          className="tm-checkbox"
                          type="checkbox"
                          aria-label={t('WorkListScreen.selectAll')}
                          checked={allVisibleSelected}
                          onChange={() =>
                            setSelected(
                              allVisibleSelected ? new Set() : new Set(rows.map((row) => row.id)),
                            )
                          }
                        />
                      </th>
                      <th scope="col" className="tm-wk-cell--type">
                        <span className="tm-visually-hidden">{t('WorkListScreen.typeHidden')}</span>
                      </th>
                      <SortableHeader
                        label={t('WorkListScreen.colWorkItem')}
                        active={sortKey === 'title'}
                        direction={sortDirection}
                        onToggle={() => toggleSort('title')}
                      />
                      <th scope="col" className="tm-wk-cell--owner">
                        {t('WorkListScreen.colOwner')}
                      </th>
                      <SortableHeader
                        label={t('WorkListScreen.colState')}
                        className="tm-wk-cell--state"
                        active={sortKey === 'state'}
                        direction={sortDirection}
                        onToggle={() => toggleSort('state')}
                      />
                      <SortableHeader
                        label={t('WorkListScreen.colDue')}
                        className="tm-wk-cell--date"
                        active={sortKey === 'due'}
                        direction={sortDirection}
                        onToggle={() => toggleSort('due')}
                      />
                      <th scope="col" className="tm-wk-cell--audience">
                        {t('WorkListScreen.colAudience')}
                      </th>
                      <th scope="col" className="tm-wk-cell--fresh">
                        {t('WorkListScreen.colFresh')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <Fragment key={group.key}>
                        {group.label !== undefined ? (
                          <tr className="tm-wk-table__group">
                            <td colSpan={8}>
                              {t('WorkListScreen.groupProjectPrefix')} {group.label}
                              <span className="tm-wk-table__group-count">
                                {localCount(group.rows.length)}{' '}
                                {group.rows.length === 1
                                  ? t('WorkListScreen.itemSingular')
                                  : t('WorkListScreen.itemPlural')}
                              </span>
                            </td>
                          </tr>
                        ) : null}
                        {group.rows.map((item) => {
                          const owner = memberDisplayName(
                            item.ownerUserId,
                            directory.members,
                            directory.isPending,
                          );
                          const overdue = isOverdue(item, now);
                          const fresh = freshness(item.updatedAt, now);
                          return (
                            <tr
                              key={item.id}
                              data-selected={selected.has(item.id)}
                              data-dragging={draggingRow === item.id || undefined}
                              data-drop-before={
                                (overRow === item.id &&
                                  draggingRow !== null &&
                                  draggingRow !== item.id) ||
                                undefined
                              }
                              {...(canReorder
                                ? {
                                    draggable: true,
                                    onDragStart: (event: DragEvent<HTMLTableRowElement>) => {
                                      event.dataTransfer.setData('text/plain', item.id);
                                      event.dataTransfer.effectAllowed = 'move';
                                      setDraggingRow(item.id);
                                      setReorderError(null);
                                    },
                                    onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
                                      if (draggingRow === null) return;
                                      event.preventDefault();
                                      event.dataTransfer.dropEffect = 'move';
                                      if (overRow !== item.id) setOverRow(item.id);
                                    },
                                    onDrop: (event: DragEvent<HTMLTableRowElement>) => {
                                      event.preventDefault();
                                      const id =
                                        event.dataTransfer.getData('text/plain') || draggingRow;
                                      setDraggingRow(null);
                                      setOverRow(null);
                                      const moving = rows.find((row) => row.id === id);
                                      if (moving && moving.id !== item.id) {
                                        void reorder(moving, item.id);
                                      }
                                    },
                                    onDragEnd: () => {
                                      setDraggingRow(null);
                                      setOverRow(null);
                                    },
                                  }
                                : {})}
                            >
                              <td>
                                <input
                                  className="tm-checkbox"
                                  type="checkbox"
                                  aria-label={`${t('WorkListScreen.selectRowPrefix')} ${item.title}`}
                                  checked={selected.has(item.id)}
                                  onChange={() => toggleRow(item.id)}
                                />
                                {canReorder ? (
                                  <button
                                    type="button"
                                    className="tm-wk-row-handle"
                                    aria-label={tOr(
                                      'WorkListScreen.reorderHandle',
                                      'Move {title}: up and down arrow keys',
                                    ).replace('{title}', item.title)}
                                    title={tOr(
                                      'WorkListScreen.reorderHint',
                                      'Drag to reorder, or use the up and down arrow keys',
                                    )}
                                    onKeyDown={(event) => {
                                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        nudgeRow(item, event.key === 'ArrowUp' ? -1 : 1);
                                      }
                                    }}
                                  >
                                    <span aria-hidden="true">⠿</span>
                                  </button>
                                ) : null}
                              </td>
                              <td className="tm-wk-cell--type">
                                <abbr className="tm-wk-table__type" title={typeName(item.type)}>
                                  {typeCode(item.type)}
                                </abbr>
                              </td>
                              <th scope="row" className="tm-table__title" title={item.title}>
                                <Link dir="auto" href={`/${organizationSlug}/work/${item.id}`}>
                                  {item.title}
                                </Link>
                              </th>
                              {/*
                            D16: who this is waiting on, by name. Resolved through the one
                            directory loaded above — no fetch per row. The orb shows initials;
                            the name is in the accessible text and the tooltip.
                          */}
                              <td className="tm-wk-cell--owner" title={owner}>
                                {/* C27: every doer, lead first — three avatars, then "+N". */}
                                {item.ownerUserId === null &&
                                (item.doerUserIds?.length ?? 0) === 0 ? (
                                  <>
                                    <span className="tm-wk-avatar" aria-hidden="true" data-empty>
                                      ?
                                    </span>
                                    <span className="tm-visually-hidden">{owner}</span>
                                  </>
                                ) : (
                                  <DoerStack
                                    doerUserIds={item.doerUserIds}
                                    ownerUserId={item.ownerUserId}
                                    nameOf={(id) =>
                                      memberDisplayName(id, directory.members, directory.isPending)
                                    }
                                  />
                                )}
                              </td>
                              <td>
                                <StateCapsule state={stateCapsule(item.state)}>
                                  {stateLabel(item.state)}
                                </StateCapsule>
                              </td>
                              <td>
                                <span
                                  className="tm-wk-mono"
                                  {...(item.dueAt === null
                                    ? { 'data-tone': 'muted' }
                                    : overdue
                                      ? { 'data-tone': 'warning' }
                                      : {})}
                                >
                                  {item.dueAt === null
                                    ? t('WorkListScreen.dueNotSet')
                                    : shortDay(item.dueAt)}
                                </span>
                                {overdue ? (
                                  <>
                                    {' '}
                                    <StateCapsule state="blocked">
                                      {t('WorkListScreen.overdue')}
                                    </StateCapsule>
                                  </>
                                ) : null}
                              </td>
                              <td className="tm-wk-cell--audience">
                                <span className="tm-wk-halo" data-audience={item.audience}>
                                  <span className="tm-wk-halo__ring" aria-hidden="true">
                                    {AUDIENCE_GLYPH[item.audience]}
                                  </span>
                                  {audienceLabel(item.audience)}
                                </span>
                              </td>
                              <td className="tm-wk-cell--fresh">
                                <time
                                  className="tm-wk-mono"
                                  data-tone={fresh.stale ? 'warning' : 'muted'}
                                  dateTime={item.updatedAt}
                                  // Minutes since the change differ between the server render and
                                  // hydration by however long the page took to arrive.
                                  suppressHydrationWarning
                                  title={`${t('WorkListScreen.lastChangedPrefix')} ${formatInstant(item.updatedAt)}`}
                                >
                                  {fresh.label}
                                </time>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tm-wk-table__foot">
                {t('WorkListScreen.footRowsPrefix')}
                {localCount(rows.length)}
                {workItems.hasNextPage ? (
                  <>
                    {' · '}
                    <span>{t('WorkListScreen.footNotAll')}</span> {t('WorkListScreen.footSortNote')}
                    <Button
                      tone="outline"
                      size="accessible"
                      loading={workItems.isFetchingNextPage}
                      loadingLabel={t('WorkListScreen.loadingMore')}
                      onClick={() => void workItems.fetchNextPage()}
                    >
                      {t('WorkListScreen.loadMore')}
                    </Button>
                  </>
                ) : (
                  ` · ${t('WorkListScreen.footAllLoaded')}`
                )}
              </p>
            </div>
          ) : null}
        </>
      )}

      {/*
        WCAG 2.2 4.1.3: "Load more" appends rows to a table that is in no live region, so a
        screen-reader user hears nothing when a page arrives. Announcing the running total into
        the shell's live region tells them the press landed.
      */}
      <Announce
        message={
          (workItems.data?.pages.length ?? 0) > 1 && !workItems.isFetchingNextPage
            ? `${localCount(loadedRows.length)} ${loadedRows.length === 1 ? t('WorkListScreen.workItemSingular') : t('WorkListScreen.workItemPlural')} ${t('WorkListScreen.loadedInTotal')}`
            : ''
        }
      />
      {view === 'board' ? (
        <CoachMarkTour
          organizationSlug={organizationSlug}
          tour="work_board"
          {...(client ? { client } : {})}
        />
      ) : null}
    </WorkViewsShell>
  );
}

/** The state filter's words, in the active language (the chips sit in the screen's own catalog). */
const STATE_FILTER_LABEL: Record<WorkItemState, MessageKey> = {
  backlog: 'WorkListScreen.stateBacklog',
  ready: 'WorkListScreen.stateReady',
  in_progress: 'WorkListScreen.stateInProgress',
  blocked: 'WorkListScreen.stateBlocked',
  internal_review: 'WorkListScreen.stateInternalReview',
  done: 'WorkListScreen.stateDone',
  archived: 'WorkListScreen.stateArchived',
};

/** The views the Work list draws in place; Timeline, Calendar and Workload are their own pages. */
const LOCAL_WORK_VIEWS = ['list', 'board'] as const;

const STATE_VIEWS = WORK_STATE_VIEWS;

const AUDIENCE_GLYPH: Record<WorkItemAudience, string> = {
  internal: '■',
  client_visible: '◎',
  client_action_required: '!',
};

/** "18 Aug" — WK-02's committed/forecast cells. A bare date is a calendar day, read in UTC. */
function shortDay(value: string): string {
  const bare = value.length === 10;
  const parsed = new Date(bare ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  // The active locale's month names and digits, so a row never mixes digit systems (C1).
  const tag = activeIsEnglish() ? 'en-GB' : appLocale();
  return new Intl.DateTimeFormat(withNumerals(tag), {
    day: 'numeric',
    month: 'short',
    ...(bare ? { timeZone: 'UTC' } : {}),
  }).format(parsed);
}

/** A count in the active locale's digits, matching the age and date cells beside it (C1). */
function localCount(value: number): string {
  // FIX5 item 6b (B-N7): the saved digit shapes ("8 مهام" with Latin digits when saved so).
  return new Intl.NumberFormat(withNumerals(appLocale())).format(value);
}

/** The list separator before a count: the Arabic comma outside English (C1). */
function listComma(): string {
  return activeIsEnglish() ? ',' : '،';
}

/** WK-02's "Fresh" column: how long since the item last changed; a fortnight reads as stale. */
function freshness(updatedAt: string, now: Date): { label: string; stale: boolean } {
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return { label: '—', stale: false };
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  const days = Math.floor(minutes / 1440);
  const label =
    minutes < 60
      ? compactUnit(minutes, 'minute')
      : minutes < 1440
        ? compactUnit(Math.floor(minutes / 60), 'hour')
        : days < 60
          ? compactUnit(days, 'day')
          : compactUnit(Math.floor(days / 30), 'month');
  return { label, stale: days >= 14 };
}

/**
 * A sortable column header. The `<th>` carries `aria-sort` — the state the arrow communicates
 * by shape must also be communicated as a word — and the control inside is a real button, so
 * it is focusable and announces itself.
 */
function SortableHeader({
  label,
  className,
  active,
  direction,
  onToggle,
}: {
  label: string;
  className?: string;
  active: boolean;
  direction: SortDirection;
  onToggle: () => void;
}) {
  return (
    <th
      scope="col"
      {...(className === undefined ? {} : { className })}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button type="button" className="tm-table__sort" onClick={onToggle}>
        {label}
        {active ? <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span> : null}
      </button>
    </th>
  );
}

function compareBy(
  key: Exclude<SortKey, 'loaded'>,
  left: WorkItemSummary,
  right: WorkItemSummary,
): number {
  if (key === 'title') return left.title.localeCompare(right.title);
  if (key === 'state') return STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state);
  // Due: items without a date sort last, which is where "no promise made" belongs.
  if (left.dueAt === null && right.dueAt === null) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt.localeCompare(right.dueAt);
}
