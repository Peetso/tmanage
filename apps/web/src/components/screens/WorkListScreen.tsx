'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Button, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listWorkItems, MAX_WORK_ITEM_PAGE, updateWorkItem } from '../../lib/api/work-items';
import type { WorkItemAudience, WorkItemSummary } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  audienceLabel,
  formatInstant,
  isClientFacing,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
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

  /*
   * The filters are part of the key, so changing one is a new query rather than a mutation of
   * the old one — the previous result stays on screen while the next loads. Pages accumulate
   * under the same key; the cursor is the last row's id, which is creation order.
   */
  const workItems = useInfiniteQuery({
    queryKey: ['work-items', organizationSlug, projectId, [...states].sort().join(',')],
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
      void queries.invalidateQueries({ queryKey: ['work-items', organizationSlug] });
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

  return (
    <AppShell
      organizationName={organizationName}
      activeNavigationId="work"
      title="Work"
      description="Everything this organization is delivering, across every project."
    >
      {/*
        The way into `REQ-01 Request inbox`. It lives here rather than on the rail because
        `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations and Requests is not
        one of them — and the design artifact's own breadcrumb reads "WORK · REQUESTS", so under
        Work is where it belongs.
      */}
      <p className="tm-prose">
        <Link href={`/${organizationSlug}/work/requests`}>
          Client requests waiting for an answer
        </Link>
      </p>

      <BackendPending ticket="WEB-002 · no server home, unscheduled">
        Saved views are not built: nothing server-side stores one, and browser storage is barred
        from holding authoritative state, so a view saved here would exist in one browser and lie
        about existing everywhere else. Priority and the blocker reason are not columns because
        neither is stored.
      </BackendPending>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-work-filters">
        <h2 id="tm-work-filters" className="tm-eyebrow">
          Filters
        </h2>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-work-project">
            Project
          </label>
          <select
            id="tm-work-project"
            className="tm-field__control"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setSelected(new Set());
            }}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="tm-fieldset">
          <legend className="tm-field__label">State</legend>
          <div className="tm-row tm-row--wrap">
            {WORK_ITEM_STATES.map((state) => (
              <label key={state} className="tm-choice tm-choice--inline">
                <input
                  className="tm-choice__input"
                  type="checkbox"
                  name="state"
                  value={state}
                  checked={states.includes(state)}
                  onChange={() => toggleState(state)}
                />
                <span className="tm-choice__name">{stateLabel(state)}</span>
              </label>
            ))}
          </div>
          <span className="tm-field__hint">
            No state ticked means every state, which is what the list opens with.
          </span>
        </fieldset>
      </section>

      {workItems.isError ? (
        <InlineAlert tone="danger" title="Could not load the work list" live>
          {describeError(workItems.error)}
        </InlineAlert>
      ) : null}

      {workItems.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading the work list.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {!workItems.isPending && !workItems.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing here yet">
          {projectId === '' && states.length === 0
            ? 'No work items exist in this organization. Create one from a project.'
            : 'No work items match these filters. Clear one to widen the list.'}
        </InlineAlert>
      ) : null}

      {workItems.hasNextPage ? (
        <InlineAlert tone="warning" title="This is not all of it">
          The list below is the first {rows.length} items; there are more. Sorting orders what is
          loaded, so load the rest before trusting an order across everything.
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
        <section className="tm-panel tm-stack" aria-labelledby="tm-work-bulk">
          <h2 id="tm-work-bulk" className="tm-eyebrow">
            {selectedRows.length} selected — set audience
          </h2>
          <div className="tm-row tm-row--wrap">
            {(['internal', 'client_visible', 'client_action_required'] as const).map((audience) => (
              <Button
                key={audience}
                tone="outline"
                size="accessible"
                disabled={bulkChange.isPending}
                onClick={() => startBulk(audience)}
              >
                {audienceLabel(audience)}
              </Button>
            ))}
          </div>

          {pendingBulk !== undefined ? (
            <InlineAlert tone="client" title="This will show items to the client" live>
              {widening.length === 0 ? (
                <p className="tm-prose">
                  Every selected item is already {audienceLabel(pendingBulk).toLowerCase()} or
                  wider. There is nothing to change.
                </p>
              ) : (
                <>
                  <p className="tm-prose">
                    {widening.length} of the {selectedRows.length} selected{' '}
                    {selectedRows.length === 1 ? 'item' : 'items'} will become{' '}
                    {audienceLabel(pendingBulk).toLowerCase()} in the client portal. Their titles
                    are what the client will read:
                  </p>
                  <ul className="tm-list">
                    {widening.map((row) => (
                      <li key={row.id}>“{row.title}”</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="tm-row">
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
              </div>
            </InlineAlert>
          ) : null}
        </section>
      ) : null}

      {rows.length > 0 ? (
        <div className="tm-table-scroll">
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Work items{projectId === '' ? '' : ' in the selected project'}, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">
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
                <th scope="col">Type</th>
                <SortableHeader
                  label="Title"
                  active={sortKey === 'title'}
                  direction={sortDirection}
                  onToggle={() => toggleSort('title')}
                />
                <SortableHeader
                  label="State"
                  active={sortKey === 'state'}
                  direction={sortDirection}
                  onToggle={() => toggleSort('state')}
                />
                <th scope="col">Project</th>
                <th scope="col">Owner</th>
                <SortableHeader
                  label="Due"
                  active={sortKey === 'due'}
                  direction={sortDirection}
                  onToggle={() => toggleSort('due')}
                />
                <th scope="col">Audience</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      className="tm-choice__input"
                      type="checkbox"
                      aria-label={`Select ${item.title}`}
                      checked={selected.has(item.id)}
                      onChange={() => toggleRow(item.id)}
                    />
                  </td>
                  <td>{item.type}</td>
                  <th scope="row" className="tm-table__title">
                    <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                  </th>
                  <td>
                    <StateCapsule state={stateCapsule(item.state)}>
                      {stateLabel(item.state)}
                    </StateCapsule>
                  </td>
                  <td>{projectNames.get(item.projectId) ?? 'Another project'}</td>
                  {/*
                    An id is not a name. Nothing exposes a person's name yet, and no ticket in
                    `28-SPRINT-TICKETS` builds a people directory; until one does this says
                    whether the item has an owner at all,
                    which is the part that matters for "who is this waiting on".
                  */}
                  <td>{item.ownerUserId === null ? 'Unassigned' : 'Assigned'}</td>
                  <td>
                    {formatInstant(item.dueAt)}
                    {isOverdue(item, now) ? (
                      <>
                        {' '}
                        <StateCapsule state="blocked">Overdue</StateCapsule>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {isClientFacing(item.audience) ? (
                      <StateCapsule state="client">{audienceLabel(item.audience)}</StateCapsule>
                    ) : (
                      audienceLabel(item.audience)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {workItems.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={workItems.isFetchingNextPage}
            loadingLabel="Loading more"
            onClick={() => void workItems.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </AppShell>
  );
}

/**
 * A sortable column header. The `<th>` carries `aria-sort` — the state the arrow communicates
 * by shape must also be communicated as a word — and the control inside is a real button, so
 * it is focusable and announces itself.
 */
function SortableHeader({
  label,
  active,
  direction,
  onToggle,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onToggle: () => void;
}) {
  return (
    <th
      scope="col"
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
