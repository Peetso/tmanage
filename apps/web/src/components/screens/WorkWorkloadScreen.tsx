'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { WorkViewsShell } from '../work/WorkViewsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkWorkload, getWorkWorkloadAll } from '../../lib/api/work-views';
import type { WorkloadRow } from '../../lib/api/work-views';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
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
  const describeError = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const directory = useMembers(api, organizationSlug);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // FIX3 item 10: no project chosen is "All work" — every project the caller can see — and the
  // view never switches to one project on its own.
  const chosenProjectId = projectId;
  const allProjectIds = useMemo(
    () => (projects.data ?? []).map((project) => project.id),
    [projects.data],
  );
  const scopeReady = chosenProjectId !== '' || allProjectIds.length > 0;

  const workload = useQuery({
    queryKey: ['work-workload', organizationSlug, chosenProjectId, allProjectIds.join(',')],
    queryFn: () =>
      chosenProjectId === ''
        ? getWorkWorkloadAll(api, organizationSlug, allProjectIds)
        : getWorkWorkload(api, organizationSlug, chosenProjectId),
    enabled: scopeReady,
  });

  const rows = useMemo(() => workload.data?.groups ?? [], [workload.data]);
  const heaviest = Math.max(1, ...rows.map((group) => group.openItemCount));
  const noProjects = projects.isSuccess && projects.data.length === 0;

  return (
    <WorkViewsShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      {...(client ? { client } : {})}
      view="workload"
      projectId={chosenProjectId}
      onChooseProject={setProjectId}
      toolbar={
        <>
          <label className="tm-visually-hidden" htmlFor="tm-workload-project">
            {t('WorkWorkloadScreen.showWorkloadFor')}
          </label>
          <select
            id="tm-workload-project"
            className="wp-select"
            value={chosenProjectId}
            disabled={projects.isPending || noProjects}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">{t('WorkListScreen.viewAllWork')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </>
      }
    >
      {noProjects ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkWorkloadScreen.noProjectTitle')}</h2>
          <p className="wp-empty__body">{t('WorkWorkloadScreen.noProjectBody')}</p>
        </div>
      ) : null}

      {workload.isError ? (
        <InlineAlert tone="danger" title={t('WorkWorkloadScreen.loadError')} live>
          {describeError(workload.error)}
        </InlineAlert>
      ) : null}

      {scopeReady && workload.isPending ? (
        <LoadingRegion label={t('WorkWorkloadScreen.loading')}>
          <Skeleton height="60px" />
          <Skeleton height="60px" />
          <Skeleton height="60px" />
        </LoadingRegion>
      ) : null}

      {scopeReady && workload.isSuccess && rows.length === 0 ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkWorkloadScreen.emptyTitle')}</h2>
          <p className="wp-empty__body">{t('WorkWorkloadScreen.emptyBody')}</p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="wp-load" role="region" aria-label={t('WorkWorkloadScreen.region')}>
          <table>
            <caption className="tm-visually-hidden">
              {t('WorkWorkloadScreen.captionPre')} {rows.length}{' '}
              {t('WorkWorkloadScreen.captionShown')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('WorkWorkloadScreen.colAssignee')}</th>
                <th scope="col">{t('WorkWorkloadScreen.colOpenItems')}</th>
                <th scope="col">{t('WorkWorkloadScreen.colOnCalendar')}</th>
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
                    <td className="wp-load__open">
                      {group.openItemCount} {t('WorkWorkloadScreen.openWord')}
                    </td>
                    <td className="wp-load__sched">
                      · {group.scheduledItemCount} {t('WorkWorkloadScreen.onCalendar')}
                    </td>
                    <td className="wp-load__barcell" aria-hidden="true">
                      <LoadBar group={group} heaviest={heaviest} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="wp-load__legend">{t('WorkWorkloadScreen.legend')}</p>
        </div>
      ) : null}
    </WorkViewsShell>
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
