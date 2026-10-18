'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useCanCreateProjects } from '../projects/NewProjectLink';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listWorkItems, MAX_WORK_ITEM_PAGE, updateWorkItem } from '../../lib/api/work-items';
import type { WorkItemAudience, WorkItemSummary } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { workItemKeys } from '../../lib/query-keys';
import {
  audienceLabel,
  formatInstant,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import type { ApiClient } from '../../lib/api/client';

export interface WorkListScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how the project overview hands off to the full list. */
  initialProjectId?: string;
  client?: ApiClient;
  /** Injected in tests so the overdue rule can be exercised without waiting for a date. */
  now?: Date;
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
}: WorkListScreenProps) {
  const api = client ?? browserApiClient();
  const canCreateProjects = useCanCreateProjects(organizationSlug, client);
  const queries = useQueryClient();

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [states, setStates] = useState<readonly WorkItemState[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('loaded');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<WorkItemAudience | undefined>(undefined);
  const [bulkReport, setBulkReport] = useState<
    { updated: number; failed: readonly { title: string; reason: string }[] } | undefined
  >(undefined);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
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
      const failed: { title: string; reason: string }[] = [];
      for (const item of input.targets) {
        try {
          await updateWorkItem(api, organizationSlug, item.id, {
            version: item.version,
            audience: input.audience,
          });
          updated += 1;
        } catch (error) {
          failed.push({ title: item.title, reason: describeError(error) });
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

  const loadedRows = useMemo(() => workItems.data?.pages.flat() ?? [], [workItems.data]);

  const rows = useMemo(() => {
    if (sortKey === 'loaded') return loadedRows;
    const sorted = [...loadedRows].sort((left, right) => compareBy(sortKey, left, right));
    if (sortDirection === 'desc') sorted.reverse();
    return sorted;
  }, [loadedRows, sortKey, sortDirection]);

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
  const countLabel = `${loadedRows.length}${workItems.hasNextPage ? '+' : ''}`;

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
      label: projectNames.get(key) ?? 'Another project',
      rows: groupRows,
    }));
  }, [rows, sortKey, projectNames]);

  function chooseStates(next: readonly WorkItemState[]) {
    setStates(next);
    setSelected(new Set());
  }

  function chooseProject(next: string) {
    setProjectId(next);
    setSelected(new Set());
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow="Work"
      title={activeView?.label ?? 'Filtered work'}
      titleMeta={
        workItems.isPending
          ? undefined
          : `${countLabel} items · ${blockedCount} blocked · ${clientWaitingCount} client waiting`
      }
      actions={
        <>
          <nav className="tm-segmented tm-wk-views" aria-label="Work views">
            <Link href={`/${organizationSlug}/work`} aria-current="page">
              List
            </Link>
            <Link href={`/${organizationSlug}/work/timeline`}>Timeline</Link>
            <Link href={`/${organizationSlug}/work/calendar`}>Calendar</Link>
            <Link href={`/${organizationSlug}/work/workload`}>Workload</Link>
          </nav>
          <Link
            href={`/${organizationSlug}/capture${projectId === '' ? '' : `?project=${encodeURIComponent(projectId)}`}`}
            className="tm-wk-new"
          >
            <span className="tm-wk-new__orb" aria-hidden="true">
              +
            </span>
            New work
          </Link>
        </>
      }
      contextRail={
        <div className="tm-wk-rail">
          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-views">
              Views
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-views">
              {STATE_VIEWS.map((view) => (
                <li key={view.label}>
                  <button
                    type="button"
                    className="tm-wk-rail__item"
                    data-kind="view"
                    aria-pressed={activeView?.label === view.label}
                    disabled={projects.isPending}
                    onClick={() => chooseStates(view.states)}
                  >
                    {view.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-projects">
              Projects
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-projects">
              {(projects.data ?? []).map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className="tm-wk-rail__item"
                    data-kind="project"
                    aria-pressed={projectId === project.id}
                    onClick={() => chooseProject(projectId === project.id ? '' : project.id)}
                  >
                    <span className="tm-wk-rail__dot" aria-hidden="true" />
                    <span className="tm-wk-rail__text">{project.name}</span>
                  </button>
                </li>
              ))}
              {canCreateProjects ? (
                <li>
                  <Link className="tm-wk-rail__item" href={`/${organizationSlug}/projects/new`}>
                    <span className="tm-wk-rail__text">+ New project</span>
                  </Link>
                </li>
              ) : null}
            </ul>
          </div>

          <div className="tm-wk-rail__group">
            <h2 className="tm-wk-rail__heading" id="tm-work-more">
              More
            </h2>
            <ul className="tm-wk-rail__group" aria-labelledby="tm-work-more">
              {/*
                The way into `REQ-01 Request inbox`: the design's breadcrumb reads
                "WORK · REQUESTS", so it lives under Work rather than on the rail.
              */}
              <li>
                <Link className="tm-wk-rail__item" href={`/${organizationSlug}/work/requests`}>
                  Client requests
                </Link>
              </li>
              <li>
                <Link className="tm-wk-rail__item" href={`/${organizationSlug}/work/saved-views`}>
                  Saved views
                </Link>
              </li>
            </ul>
          </div>
        </div>
      }
    >
      <section className="tm-wk-toolbar" aria-labelledby="tm-work-filters">
        <h2 id="tm-work-filters" className="tm-visually-hidden">
          Filters
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
          <legend>Filters</legend>
          <span className="tm-wk-select">
            <label htmlFor="tm-work-project">Project</label>
            <select
              id="tm-work-project"
              value={projectId}
              onChange={(event) => chooseProject(event.target.value)}
            >
              <option value="">All projects</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </span>

          <fieldset className="tm-wk-filters" aria-describedby="tm-work-state-hint">
            <legend>State</legend>
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
                {stateLabel(state)}
              </label>
            ))}
          </fieldset>
        </fieldset>
        <span id="tm-work-state-hint" className="tm-visually-hidden">
          No state ticked means every state, which is what the list opens with.
        </span>
      </section>

      {workItems.isError ? (
        <InlineAlert tone="danger" title="Could not load the work list" live>
          {describeError(workItems.error)}
        </InlineAlert>
      ) : null}

      {workItems.isPending ? (
        <LoadingRegion label="Loading the work list.">
          <Skeleton height="38px" />
          <Skeleton height="38px" />
          <Skeleton height="38px" />
        </LoadingRegion>
      ) : null}

      {!workItems.isPending && !workItems.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing here yet">
          {projectId === '' && states.length === 0
            ? 'No work items exist in this organization. Create one from a project.'
            : 'No work items match these filters. Clear one to widen the list.'}
        </InlineAlert>
      ) : null}

      {bulkReport !== undefined ? (
        <InlineAlert
          tone={bulkReport.failed.length === 0 ? 'neutral' : 'warning'}
          title={`Audience changed on ${bulkReport.updated} ${bulkReport.updated === 1 ? 'item' : 'items'}`}
          live
        >
          {bulkReport.failed.length > 0 ? (
            <>
              <p className="tm-prose">
                These were <strong>not</strong> applied, and were not retried — reload the list and
                decide again with the current state in view:
              </p>
              <ul className="tm-list">
                {bulkReport.failed.map((failure) => (
                  <li key={failure.title}>
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
            {selectedRows.length}
          </span>
          <h2 id="tm-work-bulk" className="tm-wk-bulk__label">
            <span className="tm-visually-hidden">{selectedRows.length} </span>selected — set
            audience
          </h2>
          <span className="tm-wk-bulk__rule" aria-hidden="true" />
          {(['internal', 'client_visible', 'client_action_required'] as const).map((audience) => (
            <button
              key={audience}
              type="button"
              disabled={bulkChange.isPending}
              onClick={() => startBulk(audience)}
            >
              {audienceLabel(audience)}
            </button>
          ))}
          <button
            type="button"
            className="tm-wk-bulk__close"
            aria-label="Clear the selection"
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
            This will show items to the client
          </h3>
          {widening.length === 0 ? (
            <p className="tm-wk-review__line">
              <span className="tm-wk-review__mark" aria-hidden="true">
                ✓
              </span>
              <span>
                Every selected item is already {audienceLabel(pendingBulk).toLowerCase()} or wider.
                There is nothing to change.
              </span>
            </p>
          ) : (
            <div className="tm-wk-review__line">
              <span className="tm-wk-review__mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <p className="tm-prose">
                  {widening.length} of the {selectedRows.length} selected{' '}
                  {selectedRows.length === 1 ? 'item' : 'items'} will become{' '}
                  {audienceLabel(pendingBulk).toLowerCase()} in the client portal. Their titles are
                  what the client will read:
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
                {selectedRows.length - widening.length} already{' '}
                {audienceLabel(pendingBulk).toLowerCase()} — left as they are.
              </span>
            </p>
          ) : null}
          <div className="tm-wk-review__actions">
            {widening.length > 0 ? (
              <Button
                tone="ink"
                size="accessible"
                loading={bulkChange.isPending}
                loadingLabel="Publishing"
                onClick={() => bulkChange.mutate({ audience: pendingBulk, targets: widening })}
              >
                Show {widening.length === 1 ? 'it' : 'them'} to the client
              </Button>
            ) : null}
            <Button tone="outline" size="accessible" onClick={() => setPendingBulk(undefined)}>
              Keep things as they are
            </Button>
            <span className="tm-wk-review__receipt">Each item keeps its own version</span>
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
            aria-label="Work items"
          >
            <table className="tm-wk-table">
              <caption className="tm-visually-hidden">
                Work items{projectId === '' ? '' : ' in the selected project'}, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="tm-wk-cell--check">
                    <input
                      className="tm-choice__input"
                      type="checkbox"
                      aria-label="Select every loaded item"
                      checked={allVisibleSelected}
                      onChange={() =>
                        setSelected(
                          allVisibleSelected ? new Set() : new Set(rows.map((row) => row.id)),
                        )
                      }
                    />
                  </th>
                  <th scope="col" className="tm-wk-cell--type">
                    <span className="tm-visually-hidden">Type</span>
                  </th>
                  <SortableHeader
                    label="Work item"
                    active={sortKey === 'title'}
                    direction={sortDirection}
                    onToggle={() => toggleSort('title')}
                  />
                  <th scope="col" className="tm-wk-cell--owner">
                    Owner
                  </th>
                  <SortableHeader
                    label="State"
                    className="tm-wk-cell--state"
                    active={sortKey === 'state'}
                    direction={sortDirection}
                    onToggle={() => toggleSort('state')}
                  />
                  <SortableHeader
                    label="Due"
                    className="tm-wk-cell--date"
                    active={sortKey === 'due'}
                    direction={sortDirection}
                    onToggle={() => toggleSort('due')}
                  />
                  <th scope="col" className="tm-wk-cell--audience">
                    Audience
                  </th>
                  <th scope="col" className="tm-wk-cell--fresh">
                    Fresh
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    {group.label !== undefined ? (
                      <tr className="tm-wk-table__group">
                        <td colSpan={8}>
                          Project · {group.label}
                          <span className="tm-wk-table__group-count">
                            {group.rows.length} {group.rows.length === 1 ? 'item' : 'items'}
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
                        <tr key={item.id} data-selected={selected.has(item.id)}>
                          <td>
                            <input
                              className="tm-choice__input"
                              type="checkbox"
                              aria-label={`Select ${item.title}`}
                              checked={selected.has(item.id)}
                              onChange={() => toggleRow(item.id)}
                            />
                          </td>
                          <td className="tm-wk-cell--type">
                            <abbr className="tm-wk-table__type" title={item.type}>
                              {typeCode(item.type)}
                            </abbr>
                          </td>
                          <th scope="row" className="tm-table__title" title={item.title}>
                            <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                          </th>
                          {/*
                            D16: who this is waiting on, by name. Resolved through the one
                            directory loaded above — no fetch per row. The orb shows initials;
                            the name is in the accessible text and the tooltip.
                          */}
                          <td className="tm-wk-cell--owner" title={owner}>
                            <span
                              className="tm-wk-avatar"
                              aria-hidden="true"
                              data-empty={item.ownerUserId === null}
                            >
                              {item.ownerUserId === null ? '?' : initialsOf(owner)}
                            </span>
                            <span className="tm-visually-hidden">{owner}</span>
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
                              {item.dueAt === null ? 'not set' : shortDay(item.dueAt)}
                            </span>
                            {overdue ? (
                              <>
                                {' '}
                                <StateCapsule state="blocked">Overdue</StateCapsule>
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
                              title={`Last changed ${formatInstant(item.updatedAt)}`}
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
            rows 1–{rows.length}
            {workItems.hasNextPage ? (
              <>
                {' · '}
                <span>This is not all of it.</span> Sorting orders what is loaded, so load the rest
                before trusting an order across everything.
                <Button
                  tone="outline"
                  size="accessible"
                  loading={workItems.isFetchingNextPage}
                  loadingLabel="Loading more"
                  onClick={() => void workItems.fetchNextPage()}
                >
                  Load more
                </Button>
              </>
            ) : (
              ' · everything is loaded'
            )}
          </p>
        </div>
      ) : null}

      {/*
        WCAG 2.2 4.1.3: "Load more" appends rows to a table that is in no live region, so a
        screen-reader user hears nothing when a page arrives. Announcing the running total into
        the shell's live region tells them the press landed.
      */}
      <Announce
        message={
          (workItems.data?.pages.length ?? 0) > 1 && !workItems.isFetchingNextPage
            ? `${loadedRows.length} ${loadedRows.length === 1 ? 'work item' : 'work items'} loaded in total.`
            : ''
        }
      />
    </AppShell>
  );
}

/** The rail's views: each is a real server-side state filter, named the way people ask for it. */
const STATE_VIEWS: readonly { label: string; states: readonly WorkItemState[] }[] = [
  { label: 'All work', states: [] },
  {
    label: 'All open work',
    states: WORK_ITEM_STATES.filter((state) => state !== 'done' && state !== 'archived'),
  },
  { label: 'Blocked work', states: ['blocked'] },
  { label: 'In internal review', states: ['internal_review'] },
  { label: 'Done', states: ['done'] },
];

function sameStates(left: readonly WorkItemState[], right: readonly WorkItemState[]): boolean {
  return left.length === right.length && left.every((state) => right.includes(state));
}

const AUDIENCE_GLYPH: Record<WorkItemAudience, string> = {
  internal: '■',
  client_visible: '◎',
  client_action_required: '!',
};

const TYPE_CODE: Record<string, string> = {
  task: 'TSK',
  bug: 'BUG',
  deliverable: 'DEL',
  document: 'DOC',
  doc: 'DOC',
  request: 'REQ',
  milestone: 'MIL',
};

function typeCode(type: string): string {
  return TYPE_CODE[type.toLowerCase()] ?? type.slice(0, 3).toUpperCase();
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** "18 Aug" — WK-02's committed/forecast cells. A bare date is a calendar day, read in UTC. */
function shortDay(value: string): string {
  const bare = value.length === 10;
  const parsed = new Date(bare ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(bare ? { timeZone: 'UTC' } : {}),
  }).format(parsed);
}

/** WK-02's "Fresh" column: how long since the item last changed; a fortnight reads as stale. */
function freshness(updatedAt: string, now: Date): { label: string; stale: boolean } {
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return { label: '—', stale: false };
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  const days = Math.floor(minutes / 1440);
  const label =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : days < 60
          ? `${days}d`
          : `${Math.floor(days / 30)}mo`;
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
