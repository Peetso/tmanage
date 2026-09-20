'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkWorkload } from '../../lib/api/work-views';
import type { WorkloadRow } from '../../lib/api/work-views';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkWorkloadScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen hands off to its workload. */
  initialProjectId?: string;
  client?: ApiClient;
}

/**
 * **WK-06 Work workload (accessible list).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work WK-06: "Workload — capacity/assignment view."
 * This is the accessible list that view rests on — a table of a project's open work grouped by who
 * carries it, each row naming an assignee, how many open items they hold, and how many of those
 * sit on the calendar (the derived load). A capacity chart is a follow-up; the list is the part
 * everyone, including a screen-reader user, can read, and it is the part that is real today. Its
 * a11y is the timeline's: a labelled scrollable region, a table caption, and column headers.
 *
 * ## What it draws, and what it cannot
 *
 * - **Order is the server's**, heaviest workload first, so the sequence a sighted user sees down
 *   the rows is the sequence the workload means — no client-side re-sort to drift from it.
 * - **The assignee is shown by id**, or "Unassigned" for the project's unowned pile. There is no
 *   endpoint that resolves a user id to a display name for an arbitrary member here, so the id is
 *   shown rather than invented — the same honesty `WorkTimelineScreen` applies to a predecessor it
 *   can only name by id.
 * - **Only open work is counted.** Done and archived items are not a workload, so the API leaves
 *   them out and the counts here are "still on the plate", not "ever touched".
 *
 * A project must be chosen before anything is fetched: the workload is per-project by definition.
 */
export function WorkWorkloadScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: WorkWorkloadScreenProps) {
  const api = client ?? browserApiClient();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const workload = useQuery({
    queryKey: ['work-workload', organizationSlug, projectId],
    queryFn: () => getWorkWorkload(api, organizationSlug, projectId),
    enabled: projectId !== '',
  });

  const rows = useMemo(() => workload.data?.groups ?? [], [workload.data]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Work workload"
      description="A project's open work grouped by who carries it, heaviest first."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-workload-filters">
        <h2 id="tm-workload-filters" className="tm-eyebrow">
          Project
        </h2>
        <fieldset className="tm-fieldset tm-stack" disabled={projects.isPending}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-workload-project">
              Show the workload for
            </label>
            <select
              id="tm-workload-project"
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
            A workload is per project. Choose one to see who is carrying its open work.
          </span>
        </fieldset>
      </section>

      {projectId === '' ? (
        <InlineAlert tone="neutral" title="Choose a project">
          Pick a project above to see its open work grouped by assignee.
        </InlineAlert>
      ) : null}

      {workload.isError ? (
        <InlineAlert tone="danger" title="Could not load the workload" live>
          {describeError(workload.error)}
        </InlineAlert>
      ) : null}

      {projectId !== '' && workload.isPending ? (
        <LoadingRegion label="Loading the workload.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {projectId !== '' && !workload.isPending && !workload.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No open work on this project">
          This project has no open work items you can see. Create one from the project.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow
          // columns (WCAG 2.2 2.1.1), matching WorkTimelineScreen's table.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Work workload"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Assignees on this project by open workload, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Assignee</th>
                <th scope="col">Open items</th>
                <th scope="col">On the calendar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((group) => (
                <tr key={group.ownerUserId ?? '__unassigned__'}>
                  <th scope="row" className="tm-table__title">
                    {assigneeLabel(group)}
                  </th>
                  <td>{group.openItemCount}</td>
                  <td>{group.scheduledItemCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppShell>
  );
}

/** The assignee cell: the owner's id, or "Unassigned" for the project's unowned open work. */
function assigneeLabel(group: WorkloadRow): string {
  return group.ownerUserId ?? 'Unassigned';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
