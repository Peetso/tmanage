'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listWorkItems, MAX_WORK_ITEM_PAGE } from '../../lib/api/work-items';
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
 * Saved views, selection, sorting and bulk actions are the second half of this ticket and are
 * named in `BackendPending` rather than half-built. Bulk audience change in particular is the
 * one the specification singles out for a separate confirmation — it is the action that can
 * disclose a dozen items to a client in one click — and a half-built version of it is worse
 * than none.
 *
 * ## Why the table is a real `<table>`
 *
 * A grid of `<div>`s can be made to look identical and cannot be navigated. A screen reader
 * announces "row 4, State, Blocked" from a real table and announces nothing from the grid,
 * and browser find-in-page, column headers and row semantics all come free. The title cell is
 * a link, so a row is reachable by Tab and openable in a new tab — `22` §5's "keyboard row
 * navigation" starts by having something focusable in the row.
 */
export function WorkListScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
  now = new Date(),
}: WorkListScreenProps) {
  const api = client ?? browserApiClient();

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [states, setStates] = useState<readonly WorkItemState[]>([]);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  /*
   * The filters are part of the key, so changing one is a new query rather than a mutation of
   * the old one. That is what makes the previous result stay on screen while the next loads,
   * instead of the table emptying every time somebody ticks a state.
   */
  const workItems = useQuery({
    queryKey: ['work-items', organizationSlug, projectId, [...states].sort().join(',')],
    queryFn: () =>
      listWorkItems(api, organizationSlug, {
        limit: MAX_WORK_ITEM_PAGE,
        ...(projectId === '' ? {} : { projectId }),
        ...(states.length === 0 ? {} : { states }),
      }),
  });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);

  function toggleState(state: WorkItemState) {
    setStates((current) =>
      current.includes(state) ? current.filter((value) => value !== state) : [...current, state],
    );
  }

  const rows = workItems.data ?? [];

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

      <BackendPending ticket="WEB-002 second half · WORK-002">
        Saved views, sorting, row selection and bulk actions are not built yet. Priority and the
        blocker reason are not columns because neither is stored: priority is not in the data model,
        and a blocker reason is recorded as part of the move into <em>Blocked</em> rather than as a
        field on the item.
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
            onChange={(event) => setProjectId(event.target.value)}
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
          {workItems.error instanceof ApiRequestError
            ? workItems.error.message
            : workItems.error instanceof NetworkError
              ? 'The API did not answer. Is it running?'
              : 'Something went wrong. Try again.'}
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

      {rows.length >= MAX_WORK_ITEM_PAGE ? (
        <InlineAlert tone="warning" title="This is not all of it">
          The API returns at most {MAX_WORK_ITEM_PAGE} items in one page and it returned a full one,
          so there is more work than is listed below. Filter by project or by state to see the rest.
          Paging through the whole list is the second half of this screen.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div className="tm-table-scroll">
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Work items{projectId === '' ? '' : ' in the selected project'}, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Project</th>
                <th scope="col">Owner</th>
                <th scope="col">Due</th>
                <th scope="col">Audience</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
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
    </AppShell>
  );
}
