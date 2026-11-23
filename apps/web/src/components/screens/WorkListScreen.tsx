'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { WorkItemState } from '@tmanage/domain';
import { Announce, Button, InlineAlert } from '@tmanage/ui';
import { WorkViewsShell, teamsKey } from '../work/WorkViewsShell';
import './work-core.css';
import '../work/list/work-list.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { fetchTeam, listTeams } from '../../lib/api/people-teams';
import { listClientOrganizationOptions } from '../../lib/api/project-client';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import {
  listWorkItems,
  MAX_WORK_ITEM_PAGE,
  transitionWorkItem,
  updateWorkItem,
} from '../../lib/api/work-items';
import type { WorkItemAudience, WorkItemSummary } from '../../lib/api/work-items';
import { NetworkError } from '../../lib/api/errors';
import { workItemKeys } from '../../lib/query-keys';
import { projectWorkTopic, useWorkLiveRefresh } from '../../lib/use-work-live-refresh';
import { audienceLabel } from '../../lib/work-item-presentation';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import type { ApiClient } from '../../lib/api/client';
import { withNumerals } from '../../lib/i18n/display-format';
import { appLocale } from '../../lib/i18n/app-locale';
import { activeIsEnglish } from '../../lib/i18n/compact-time';
import { countNoun } from '../../lib/i18n/plural';
import { useT } from '../../lib/i18n/use-t';
import { useA6T, todayOf } from '../work/DueDatePicker';
import { WorkBoardView } from './WorkBoardView';
import { byRank, rankForDrop, useWorkDragPermissions } from '../../lib/work-drag';
import { CoachMarkTour } from '../help/CoachMarkTour';
import { useViewPreference } from '../views/use-view-preference';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useUndoEntries } from '../../lib/undo/use-undo';
import { heldKeys, undoKey } from '../../lib/undo/undo-queue';
import { autoFacts, movesTo } from '../work/stages/stage-model';
import { useProjectStageSet, useStageSets } from '../work/stages/use-work-stages';
import { CheckIcon, InfoIcon } from '../work/work-icons';
import { WorkFilterBar } from '../work/list/WorkFilterBar';
import { WorkRows, type SortDirection, type SortKey } from '../work/list/WorkRows';
import {
  NO_FILTERS,
  applyLoadedFilters,
  isFiltered,
  railCounts,
  workListQuery,
  type WorkListFilters,
  type WorkListView,
} from '../work/list/work-list-model';

export { parseStateParam, workListQuery } from '../work/list/work-list-model';

/** 53-01: the most project topics one list view follows live. */
const LIVE_PROJECT_LIMIT = 50;
/** Rows drawn before "Show more"; more come from the loaded pages, then from the API. */
const WINDOW = 50;
/** Teams whose members are read for the rail counts (one small read each). */
const TEAM_COUNT_LIMIT = 12;

export interface WorkListScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how the project overview hands off to the full list. */
  initialProjectId?: string;
  /** The filters the address carried (`?state=`, `?stage=`, `?doer=`, `?team=`, `?due=`). */
  initialFilters?: Partial<WorkListFilters>;
  /** The state filter to open on (`?state=` in the URL), so a reload keeps it. */
  initialStates?: readonly WorkItemState[];
  client?: ApiClient;
  /** Injected in tests and stories so the dates and ages read the same every run. */
  now?: Date;
  /** A6: open on the board rather than the list. */
  initialView?: WorkListView;
}

/**
 * **TM-10 Works list and board (Work area v2, W-WEB-2; Figma `WV2-01`, `WV2-09`, `WV2-10`).**
 *
 * - **Filters** live in the address and in {@link WorkListFilters}; project, state and team go
 *   to the API, doer, due and a named stage filter the loaded rows (`work-list-model.ts`).
 * - **Paging** is the API's `after` cursor; the window shows {@link WINDOW} rows at a time and
 *   "Show more" draws the next ones, asking the API for the next page when the loaded ones run
 *   out (I-4). The footer says "Showing N of M" over what is loaded, with "+" while more exist.
 * - **Sorting** orders the loaded rows; the hand-made order (drag, or the handle's arrow keys)
 *   applies when no sort is on (FIX3 item C).
 * - **The row tick** marks a work done through the lifecycle's own moves, or sends it for review
 *   when a supervisor other than the reader approves it (C27); anything that needs a reason is
 *   left to the work page.
 * - **Bulk "who sees it"** is kept: select rows in the start gutter; widening shows the titles
 *   that will reach the client before it is sent, each with its own version, never retried.
 */
export function WorkListScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  initialFilters,
  initialStates,
  client,
  now = new Date(),
  initialView,
}: WorkListScreenProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const ta = useA6T();
  // R38 G5-views: a `?view=` in the address wins; otherwise the last view chosen on this page.
  const [view, setView] = useViewPreference<WorkListView>(
    `work:${organizationSlug}`,
    LOCAL_WORK_VIEWS,
    'list',
    initialView,
  );
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [filters, setFilters] = useState<WorkListFilters>(() => ({
    ...NO_FILTERS,
    ...initialFilters,
    ...(initialProjectId === undefined ? {} : { projectId: initialProjectId }),
    ...(initialStates === undefined ? {} : { states: initialStates }),
  }));
  const [sortKey, setSortKey] = useState<SortKey>('loaded');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [shownCount, setShownCount] = useState(WINDOW);
  const [rankOverrides, setRankOverrides] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [reorderError, setReorderError] = useState<{ title: string; reason: string } | null>(null);
  const [tickError, setTickError] = useState<{ title: string; reason: string } | null>(null);
  const [ticking, setTicking] = useState<ReadonlySet<string>>(() => new Set());
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const dragRights = useWorkDragPermissions(api, organizationSlug);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<WorkItemAudience | undefined>(undefined);
  const [bulkReport, setBulkReport] = useState<
    | { updated: number; failed: readonly { id: string; title: string; reason: string }[] }
    | undefined
  >(undefined);
  const today = todayOf(now);
  const { projectId, states, teamId } = filters;

  // The address follows the view and the filters, so a reload or a shared link reopens them.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = `${window.location.pathname}${workListQuery({ view, filters })}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [view, filters]);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const viewerUserId = me.data?.userId ?? null;
  const teams = useQuery({
    queryKey: teamsKey(organizationSlug),
    queryFn: () => listTeams(api, organizationSlug),
  });
  const teamDetails = useQueries({
    queries: (teams.data?.teams ?? []).slice(0, TEAM_COUNT_LIMIT).map((team) => ({
      queryKey: ['people-team', organizationSlug, team.id],
      queryFn: () => fetchTeam(api, organizationSlug, team.id),
      staleTime: 60_000,
    })),
  });
  const clientOptions = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
    // A member without the right to list them still sees "Client can follow" (ClientName).
    retry: false,
    staleTime: 5 * 60_000,
  });
  const stageSets = useStageSets(api, organizationSlug);
  const projectSet = useProjectStageSet(api, organizationSlug, projectId === '' ? null : projectId);
  const shownSet = projectSet.data?.stageSet ?? null;
  const namedProjectSet = shownSet && !shownSet.isBuiltIn ? shownSet : null;

  // 53-01: the list and the board refetch when work in the shown project(s) changes elsewhere.
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

  // D16. One directory for every row's faces, resolved through one map rather than a fetch per row.
  const directory = useMembers(api, organizationSlug);
  const nameOf = (id: string) => memberDisplayName(id, directory.members, directory.isPending);
  const clientNames = useMemo(
    () => new Map((clientOptions.data ?? []).map((entry) => [entry.id, entry.name])),
    [clientOptions.data],
  );

  /*
   * The server-side filters are part of the key, so changing one is a new query rather than a
   * mutation of the old one. Pages accumulate under the same key; the cursor is the last row's id.
   */
  const workItems = useInfiniteQuery({
    queryKey: workItemKeys.list(organizationSlug, projectId, states, teamId),
    queryFn: ({ pageParam }) =>
      listWorkItems(api, organizationSlug, {
        limit: MAX_WORK_ITEM_PAGE,
        ...(projectId === '' ? {} : { projectId }),
        ...(states.length === 0 ? {} : { states }),
        ...(teamId === '' ? {} : { teamId }),
        ...(pageParam === undefined ? {} : { after: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === MAX_WORK_ITEM_PAGE ? lastPage[lastPage.length - 1]?.id : undefined,
  });

  // The rail's counts come from the first page of every work: the same cache entry the
  // unfiltered list uses, so on "All work" there is no second read.
  const everything = useInfiniteQuery({
    queryKey: workItemKeys.list(organizationSlug, '', [], ''),
    queryFn: ({ pageParam }) =>
      listWorkItems(api, organizationSlug, {
        limit: MAX_WORK_ITEM_PAGE,
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

  // 55-23: an item whose delete is held behind an Undo toast is already gone from the list.
  const heldUndo = useUndoEntries();
  const loadedRows = useMemo(() => {
    const held = heldKeys(heldUndo);
    return (workItems.data?.pages.flat() ?? []).filter((row) => !held.has(undoKey('work', row.id)));
  }, [workItems.data, heldUndo]);

  useEffect(() => {
    setRankOverrides(new Map());
  }, [loadedRows]);

  const filteredRows = useMemo(
    () => applyLoadedFilters(loadedRows, filters, { today, viewerUserId }),
    [loadedRows, filters, today, viewerUserId],
  );

  const rows = useMemo(() => {
    if (sortKey === 'loaded') {
      // The hand-made order: what people dragged, else when the item was made.
      return byRank(
        filteredRows.map((row) => {
          const rank = rankOverrides.get(row.id);
          return rank === undefined ? row : { ...row, rank };
        }),
      );
    }
    const sorted = [...filteredRows].sort((left, right) => compareBy(sortKey, left, right));
    if (sortDirection === 'desc') sorted.reverse();
    return sorted;
  }, [filteredRows, sortKey, sortDirection, rankOverrides]);

  const visibleRows = rows.slice(0, shownCount);
  const canReorder = dragRights.canUpdate && sortKey === 'loaded';

  const counts = useMemo(() => {
    if (!everything.data) return undefined;
    const teamMembers = new Map<string, readonly string[]>();
    for (const detail of teamDetails) {
      const members = detail.data?.members;
      if (detail.data && members) {
        teamMembers.set(
          detail.data.id,
          members.map((member) => member.userId),
        );
      }
    }
    return railCounts(everything.data.pages.flat(), {
      today,
      viewerUserId,
      teamMembers,
      partial: everything.hasNextPage,
    });
  }, [everything.data, everything.hasNextPage, teamDetails, today, viewerUserId]);

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
      setReorderError({ title: item.title, reason: describeError(error) });
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

  /**
   * The row tick. Done, through the lifecycle's own moves; when the work has a supervisor who is
   * not the reader, it goes to review instead — the supervisor approves it (C27). A move that
   * needs a reason or an owner is not guessed at: the message sends the reader to the work page.
   */
  async function tick(item: WorkItemSummary) {
    setTickError(null);
    const supervisors = item.supervisorUserIds ?? [];
    const target: WorkItemState =
      supervisors.length > 0 && (viewerUserId === null || !supervisors.includes(viewerUserId))
        ? 'internal_review'
        : 'done';
    if (item.state === target) return;
    const run = movesTo(item.state, target);
    const facts = run === null ? null : autoFacts(run.needs, item.ownerUserId, new Date());
    if (run === null || facts === null || facts.ask.length > 0) {
      setTickError({
        title: item.title,
        reason: ta(
          facts?.ask.includes('ownerId') ? 'WorkBoard.moveNeedsOwner' : 'WorkBoard.moveNeedsDetail',
        ),
      });
      return;
    }
    setTicking((current) => new Set(current).add(item.id));
    try {
      let at = item;
      for (const to of run.before) {
        at = await transitionWorkItem(api, organizationSlug, item.id, { version: at.version, to });
      }
      await transitionWorkItem(api, organizationSlug, item.id, {
        version: at.version,
        to: target,
        facts: facts.facts,
      });
    } catch (error) {
      setTickError({ title: item.title, reason: describeError(error) });
    } finally {
      setTicking((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
    }
  }

  const selectedRows = rows.filter((row) => selected.has(row.id));

  function chooseFilters(next: WorkListFilters) {
    setFilters(next);
    setSelected(new Set());
    setShownCount(WINDOW);
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

  function showMore() {
    const next = shownCount + WINDOW;
    setShownCount(next);
    if (next > rows.length && workItems.hasNextPage && !workItems.isFetchingNextPage) {
      void workItems.fetchNextPage();
    }
  }

  const widening =
    pendingBulk === undefined ? [] : selectedRows.filter((row) => row.audience !== pendingBulk);

  const blockedCount = filteredRows.filter((row) => row.state === 'blocked').length;
  const more = workItems.hasNextPage ? '+' : '';
  const itemWord = workItems.hasNextPage
    ? t('WorkListScreen.itemPlural')
    : countNoun(
        appLocale(),
        filteredRows.length,
        t('WorkListScreen.itemSingular'),
        t('WorkListScreen.itemPlural'),
      );
  // Nothing loaded says no count: "0 items" under "Work did not load" would be false.
  const titleMeta = workItems.isPending
    ? ta('WorkListScreen.loadingMeta')
    : workItems.isError && filteredRows.length === 0
      ? undefined
      : `${localCount(filteredRows.length)}${more} ${itemWord}${
          blockedCount > 0
            ? ` · ${localCount(blockedCount)} ${t('WorkListScreen.metaBlocked')}`
            : ''
        }`;

  const offline = workItems.isError && workItems.error instanceof NetworkError;
  const stateFrame = workItems.isError ? (
    <div className="tm-wl-state" data-tone={offline ? 'warning' : 'danger'} role="alert">
      <span className="tm-wl-state__icon" aria-hidden="true">
        <InfoIcon />
      </span>
      <h2 className="tm-wl-state__title">
        {ta(offline ? 'WorkListScreen.offlineTitle' : 'WorkListScreen.errorTitle')}
      </h2>
      <p>{ta(offline ? 'WorkListScreen.offlineBody' : 'WorkListScreen.errorBody')}</p>
      <button
        type="button"
        className="tm-wl-state__action"
        onClick={() => void workItems.refetch()}
      >
        {ta('WorkListScreen.tryAgain')}
      </button>
    </div>
  ) : !workItems.isPending && rows.length === 0 ? (
    <div className="tm-wl-state">
      <span className="tm-wl-state__icon" aria-hidden="true">
        <CheckIcon />
      </span>
      {isFiltered(filters) ? (
        <>
          <p>{ta('WorkListScreen.emptyFiltered')}</p>
          <button
            type="button"
            className="tm-wl-state__action"
            onClick={() => chooseFilters(NO_FILTERS)}
          >
            {ta('WorkListScreen.clearFilters')}
          </button>
        </>
      ) : (
        <>
          <p>{ta('WorkListScreen.emptyFirst')}</p>
          <Link
            className="tm-wl-state__action"
            data-primary="true"
            href={`/${organizationSlug}/capture`}
          >
            {t('WorkListScreen.newWork')}
          </Link>
        </>
      )}
    </div>
  ) : null;

  return (
    <WorkViewsShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      {...(client ? { client } : {})}
      view={view}
      projectId={projectId}
      onChooseProject={(next) => chooseFilters({ ...filters, projectId: next, stageIds: [] })}
      filters={filters}
      onChooseFilters={chooseFilters}
      onLocalViewChange={setView}
      {...(counts ? { counts } : {})}
      titleMeta={titleMeta}
      toolbar={
        <WorkFilterBar
          filters={filters}
          onChange={chooseFilters}
          disabled={projects.isPending}
          projects={(projects.data ?? []).filter((project) => !project.archivedAt)}
          projectSet={namedProjectSet}
          members={directory.members}
          viewerUserId={viewerUserId}
          teams={teams.data?.teams ?? []}
        />
      }
    >
      {(reorderError ?? tickError) ? (
        <InlineAlert tone="danger" title={ta('WorkBoard.moveNotAllowed')} live>
          {ta('WorkBoard.moveNotAllowedBody', {
            title: (reorderError ?? tickError)?.title ?? '',
            reason: (reorderError ?? tickError)?.reason ?? '',
          })}
        </InlineAlert>
      ) : null}

      {view === 'board' ? (
        (stateFrame ??
        (workItems.isPending ? (
          <LoadingRows label={t('WorkListScreen.loadingList')} />
        ) : (
          <WorkBoardView
            organizationSlug={organizationSlug}
            items={filteredRows}
            nameOf={nameOf}
            clientNameOf={(id) => clientNames.get(id)}
            stageSet={namedProjectSet}
            sets={stageSets.data ?? []}
            addHref={() =>
              `/${organizationSlug}/capture${projectId === '' ? '' : `?project=${encodeURIComponent(projectId)}`}`
            }
            api={api}
            dragRights={dragRights}
            onMoved={() =>
              void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) })
            }
          />
        )))
      ) : (
        <>
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

          {stateFrame ??
            (workItems.isPending ? (
              <LoadingRows label={t('WorkListScreen.loadingList')} />
            ) : (
              <>
                <WorkRows
                  organizationSlug={organizationSlug}
                  rows={visibleRows}
                  now={now}
                  sets={stageSets.data ?? []}
                  nameOf={nameOf}
                  clientNameOf={(id) => clientNames.get(id)}
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={toggleSort}
                  selected={selected}
                  onToggleRow={toggleRow}
                  onToggleAll={() =>
                    setSelected(
                      visibleRows.every((row) => selected.has(row.id))
                        ? new Set()
                        : new Set(visibleRows.map((row) => row.id)),
                    )
                  }
                  onTick={(item) => void tick(item)}
                  ticking={ticking}
                  caption={`${t('WorkListScreen.colCaption')}${
                    projectId === '' ? '' : ` ${t('WorkListScreen.colCaptionInProject')}`
                  }${listComma()} ${localCount(visibleRows.length)} ${t('WorkListScreen.shown')}`}
                  {...(canReorder
                    ? {
                        reorder: {
                          dragging: draggingRow,
                          over: overRow,
                          onDragStart: (id: string) => {
                            setDraggingRow(id);
                            setReorderError(null);
                          },
                          onDragOver: (id: string) => {
                            if (overRow !== id) setOverRow(id);
                          },
                          onDrop: (id: string, onto: string) => {
                            setDraggingRow(null);
                            setOverRow(null);
                            const moving = rows.find((row) => row.id === id);
                            if (moving && moving.id !== onto) void reorder(moving, onto);
                          },
                          onDragEnd: () => {
                            setDraggingRow(null);
                            setOverRow(null);
                          },
                          onNudge: nudgeRow,
                        },
                      }
                    : {})}
                />
                <p className="tm-wl-foot">
                  <span>
                    {ta('WorkListScreen.showing', {
                      shown: localCount(visibleRows.length),
                      total: `${localCount(rows.length)}${more}`,
                    })}
                  </span>
                  {visibleRows.length < rows.length || workItems.hasNextPage ? (
                    <button
                      type="button"
                      className="tm-wl-ghost"
                      disabled={workItems.isFetchingNextPage}
                      onClick={showMore}
                    >
                      {workItems.isFetchingNextPage
                        ? t('WorkListScreen.loadingMore')
                        : ta('WorkListScreen.showMore')}
                    </button>
                  ) : null}
                </p>
              </>
            ))}
        </>
      )}

      {/*
        WCAG 2.2 4.1.3: "Show more" appends rows to a table that is in no live region, so a
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

/** Figma `WV2-09` loading: the real header and toolbar, skeleton rows under the table head. */
function LoadingRows({ label }: { label: string }) {
  return (
    <div className="tm-wl-frame" role="status" aria-busy="true" aria-label={label}>
      <table className="tm-wl-table" aria-hidden="true">
        <tbody>
          {Array.from({ length: 10 }, (_, index) => (
            <tr key={index}>
              <td className="tm-wl-cell--tick">
                <span className="tm-wl-skeleton" />
              </td>
              <td className="tm-wl-cell--title">
                <span className="tm-wl-skeleton" />
              </td>
              <td>
                <span className="tm-wl-skeleton" />
              </td>
              <td>
                <span className="tm-wl-skeleton" />
              </td>
              <td>
                <span className="tm-wl-skeleton" />
              </td>
              <td>
                <span className="tm-wl-skeleton" />
              </td>
              <td>
                <span className="tm-wl-skeleton" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The views the Work list draws in place; Timeline, Calendar and Workload are their own pages. */
const LOCAL_WORK_VIEWS = ['list', 'board'] as const;

/** Lifecycle order, so sorting by stage groups the lifecycle rather than the alphabet. */
const STATE_ORDER: readonly WorkItemState[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
  'done',
  'archived',
];

/** A count in the active locale's digits, matching the date cells beside it (C1). */
function localCount(value: number): string {
  // FIX5 item 6b (B-N7): the saved digit shapes ("8 مهام" with Latin digits when saved so).
  return new Intl.NumberFormat(withNumerals(appLocale())).format(value);
}

function compareBy(
  key: Exclude<SortKey, 'loaded'>,
  left: WorkItemSummary,
  right: WorkItemSummary,
): number {
  if (key === 'title') return left.title.localeCompare(right.title);
  if (key === 'stage') return STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state);
  // Updated: the most recent first when ascending, like every inbox.
  if (key === 'updated') return right.updatedAt.localeCompare(left.updatedAt);
  // Due: items without a date sort last, which is where "no promise made" belongs.
  if (left.dueAt === null && right.dueAt === null) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt.localeCompare(right.dueAt);
}

/** The list separator before a count: the Arabic comma outside English (C1). */
function listComma(): string {
  return activeIsEnglish() ? ',' : '،';
}
