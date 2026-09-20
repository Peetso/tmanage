'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkTimeline } from '../../lib/api/work-views';
import type { WorkTimelineRow } from '../../lib/api/work-views';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface WorkTimelineScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen hands off to its timeline. */
  initialProjectId?: string;
  client?: ApiClient;
}

/**
 * **WK-04 Work timeline (accessible list).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work WK-04: "Timeline/Gantt — Milestones/dependencies,
 * baseline/forecast, accessible list." This is the accessible list the plan names — a table of a
 * project's work items in timeline order (start, then due, then creation), each row naming what
 * it depends on. A Gantt canvas is a follow-up; the list is the part everyone, including a
 * screen-reader user, can read, and it is the part that is real today.
 *
 * ## What it draws, and what it cannot
 *
 * - **Order is the server's**, computed from `start_at`/`due_at`, so the sequence a sighted user
 *   sees down the rows is the sequence the timeline means — no client-side re-sort to drift from it.
 * - **Dependencies are ids the caller may read.** A predecessor in a project the caller cannot
 *   see is redacted by the API (its id never arrives), so the "Depends on" cell only ever names
 *   work the reader is entitled to. An id that belongs to another project in this timeline's
 *   response but not to this project's rows is shown as the id; one that matches a row is shown
 *   by that row's title.
 * - **Baseline/forecast is not drawn**, because neither is stored — the same honesty
 *   `WorkListScreen` applies to priority and blocker columns that have no data behind them.
 *
 * A project must be chosen before anything is fetched: the timeline is per-project by definition,
 * and "all projects at once" is not a timeline, it is the list screen.
 */
export function WorkTimelineScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: WorkTimelineScreenProps) {
  const api = client ?? browserApiClient();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const timeline = useQuery({
    queryKey: ['work-timeline', organizationSlug, projectId],
    queryFn: () => getWorkTimeline(api, organizationSlug, projectId),
    enabled: projectId !== '',
  });

  const rows = useMemo(() => timeline.data?.items ?? [], [timeline.data]);

  // A row's own title by id, so a predecessor edge into this timeline reads as a name, not an id.
  const titlesById = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) names.set(row.id, row.title);
    return names;
  }, [rows]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Work timeline"
      description="A project's work in timeline order, with what each item depends on."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-timeline-filters">
        <h2 id="tm-timeline-filters" className="tm-eyebrow">
          Project
        </h2>
        <fieldset className="tm-fieldset tm-stack" disabled={projects.isPending}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-timeline-project">
              Show the timeline for
            </label>
            <select
              id="tm-timeline-project"
              className="tm-field__control"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <span className="tm-field__hint">
            A timeline is per project. Choose one to see its work in order.
          </span>
        </fieldset>
      </section>

      {projectId === '' ? (
        <InlineAlert tone="neutral" title="Choose a project">
          Pick a project above to see its work items in timeline order.
        </InlineAlert>
      ) : null}

      {timeline.isError ? (
        <InlineAlert tone="danger" title="Could not load the timeline" live>
          {describeError(timeline.error)}
        </InlineAlert>
      ) : null}

      {projectId !== '' && timeline.isPending ? (
        <LoadingRegion label="Loading the timeline.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {projectId !== '' && !timeline.isPending && !timeline.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing on this timeline yet">
          This project has no work items you can see. Create one from the project.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow
          // columns (WCAG 2.2 2.1.1), matching WorkListScreen's table.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Work timeline"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Work items in this project in timeline order, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Start</th>
                <th scope="col">Due</th>
                <th scope="col">Depends on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <th scope="row" className="tm-table__title">
                    <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                  </th>
                  <td>
                    <StateCapsule state={stateCapsule(item.state)}>
                      {stateLabel(item.state)}
                    </StateCapsule>
                  </td>
                  <td>{formatInstant(item.startAt)}</td>
                  <td>{formatInstant(item.dueAt)}</td>
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

/** The "Depends on" cell: predecessor titles where known, ids otherwise, or an em dash for none. */
function dependsOnLabel(row: WorkTimelineRow, titlesById: ReadonlyMap<string, string>): string {
  if (row.predecessorIds.length === 0) return '—';
  return row.predecessorIds.map((id) => titlesById.get(id) ?? id).join(', ');
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
