'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkWorkload } from '../../lib/api/work-views';
import type { WorkloadRow } from '../../lib/api/work-views';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/work-planning.css';

export interface WorkWorkloadScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Pre-select a project (deep link `?project=`). Defaults to the first project the caller sees. */
  initialProjectId?: string;
  client?: ApiClient;
}

/**
 * **WK-06 Workload** — "Commitments against capacity" from `TManage Screens - Work
 * Extended.dc.html`, over the workload read (`GET .../work-views/workload/:projectId`).
 *
 * One row per assignee in the server's order (heaviest first, the unassigned pile named in
 * words): the person's orb and name, their open and scheduled counts in mono, and a segmented
 * bar with one block per open item — solid ink for what is on the calendar, an ink outline for
 * what has no date yet, and the paper remainder up to the heaviest load on the project. Nobody
 * is scored: the artboard's hours and stated capacity are not modelled, so the bar compares
 * people only by count.
 *
 * Still a table underneath — a labelled region, a caption, a row header per assignee and a cell
 * per count — styled into the artboard's card, so the list structure a screen reader walks is
 * the one the timeline carries.
 */
export function WorkWorkloadScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: WorkWorkloadScreenProps) {
  const api = client ?? browserApiClient();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const directory = useMembers(api, organizationSlug);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // A workload is per project: with none chosen, the first project the caller can see.
  const chosenProjectId = projectId !== '' ? projectId : (projects.data?.[0]?.id ?? '');
  const projectName = projects.data?.find((project) => project.id === chosenProjectId)?.name;

  const workload = useQuery({
    queryKey: ['work-workload', organizationSlug, chosenProjectId],
    queryFn: () => getWorkWorkload(api, organizationSlug, chosenProjectId),
    enabled: chosenProjectId !== '',
  });

  const rows = useMemo(() => workload.data?.groups ?? [], [workload.data]);
  const heaviest = Math.max(1, ...rows.map((group) => group.openItemCount));
  const noProjects = projects.isSuccess && projects.data.length === 0;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Commitments against capacity"
      eyebrow={projectName ? `Workload · ${projectName}` : 'Workload'}
      actions={
        <div className="wp-toolbar">
          <nav className="wp-segmented" aria-label="Work views">
            <Link href={`/${organizationSlug}/work`}>List</Link>
            <Link
              href={`/${organizationSlug}/work/timeline${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              Timeline
            </Link>
            {/* CQ-07 (WRK-08): the switcher was missing Calendar; the four views now match. */}
            <Link
              href={`/${organizationSlug}/work/calendar${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              Calendar
            </Link>
            <span aria-current="page">Workload</span>
          </nav>
          <label className="tm-visually-hidden" htmlFor="tm-workload-project">
            Show the workload for
          </label>
          <select
            id="tm-workload-project"
            className="wp-select"
            value={chosenProjectId}
            disabled={projects.isPending || noProjects}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {chosenProjectId === '' ? <option value="">Choose a project…</option> : null}
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {noProjects ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">No project to show yet</h2>
          <p className="wp-empty__body">
            A workload is per project. Once you can see a project, who carries its open work appears
            here.
          </p>
        </div>
      ) : null}

      {workload.isError ? (
        <InlineAlert tone="danger" title="Could not load the workload" live>
          {describeError(workload.error)}
        </InlineAlert>
      ) : null}

      {chosenProjectId !== '' && workload.isPending ? (
        <LoadingRegion label="Loading the workload.">
          <Skeleton height="60px" />
          <Skeleton height="60px" />
          <Skeleton height="60px" />
        </LoadingRegion>
      ) : null}

      {chosenProjectId !== '' && workload.isSuccess && rows.length === 0 ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">No open work on this project</h2>
          <p className="wp-empty__body">
            This project has no open work items you can see. Create one from the project.
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="wp-load" role="region" aria-label="Work workload">
          <table>
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
              {rows.map((group) => {
                const name = memberDisplayName(
                  group.ownerUserId,
                  directory.members,
                  directory.isPending,
                );
                return (
                  <tr key={group.ownerUserId ?? '__unassigned__'}>
                    <th scope="row">
                      <span
                        className={`wp-load__avatar${
                          group.ownerUserId === null ? ' wp-load__avatar--none' : ''
                        }`}
                        aria-hidden="true"
                      >
                        {group.ownerUserId === null ? '?' : initialsOf(name)}
                      </span>
                      <span>{name}</span>
                    </th>
                    <td className="wp-load__open">{group.openItemCount} open</td>
                    <td className="wp-load__sched">· {group.scheduledItemCount} on the calendar</td>
                    <td className="wp-load__barcell" aria-hidden="true">
                      <LoadBar group={group} heaviest={heaviest} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="wp-load__legend">
            Solid = on the calendar · Outline = no date yet · Counts only, nobody is scored
          </p>
        </div>
      ) : null}
    </AppShell>
  );
}

/** One block per open item: scheduled ones solid, undated ones outlined, the rest paper. */
function LoadBar({ group, heaviest }: { group: WorkloadRow; heaviest: number }) {
  const scheduled = Math.min(group.scheduledItemCount, group.openItemCount);
  const unscheduled = group.openItemCount - scheduled;
  const rest = heaviest - group.openItemCount;
  return (
    <div className="wp-load__bar">
      {Array.from({ length: scheduled }, (_, index) => (
        <span key={`s${index}`} className="wp-load__seg" />
      ))}
      {Array.from({ length: unscheduled }, (_, index) => (
        <span key={`u${index}`} className="wp-load__seg wp-load__seg--open" />
      ))}
      {rest > 0 ? (
        <span className="wp-load__seg wp-load__seg--rest" style={{ flexGrow: rest }} />
      ) : null}
    </div>
  );
}

function initialsOf(name: string): string {
  const words = name
    .replace(/\(.*\)/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
