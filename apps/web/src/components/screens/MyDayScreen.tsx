'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getMyDay } from '../../lib/api/home';
import type { MyDayReason } from '../../lib/api/home';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface MyDayScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **HOME-03 Personal work** — the first vertical slice of Home / My Day (`41-WHOLE-APP-SCREEN`
 * §1 HOME-01/03). It replaces the `HOME-001` stub with the ranked "what needs you today" spine:
 * the acting user's own open work across every project, ordered overdue → due-soon → the rest,
 * each row saying in a word why it is on the list.
 *
 * ## What this renders, and what it does not
 *
 * One section — Personal work. The API does the ranking and names the reason per row, so this
 * screen is a faithful reader of that order rather than a second place the rule could drift to.
 * The editorial hero, the schedule Pulse Track and the Focus Capsule (HOME-01), Waiting
 * (HOME-04, which reads approvals) and Saved/pinned (HOME-05) are the later slices this spine
 * is built to carry; they are deliberately absent rather than stubbed.
 */
export function MyDayScreen({ organizationSlug, organizationName, client }: MyDayScreenProps) {
  const api = client ?? browserApiClient();

  const myDay = useQuery({
    queryKey: ['home', 'my-day', organizationSlug],
    queryFn: () => getMyDay(api, organizationSlug),
  });

  // Names for the project each item belongs to — My Day spans every project, so an id alone
  // would not tell the reader which one. One directory, resolved through a map, no fetch per row.
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);

  const items = myDay.data?.items ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title="Home"
      description="What needs you today, across every project."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-my-day-personal">
        <h2 id="tm-my-day-personal" className="tm-eyebrow">
          Personal work
        </h2>

        {myDay.isError ? (
          <InlineAlert tone="danger" title="Could not load your work" live>
            {describeError(myDay.error)}
          </InlineAlert>
        ) : null}

        {myDay.isPending ? (
          <LoadingRegion label="Loading your work.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!myDay.isPending && !myDay.isError && items.length === 0 ? (
          <InlineAlert tone="neutral" title="Nothing needs you right now">
            You have no open work assigned to you. Work assigned to you across any project shows up
            here, with what is overdue or due soon first.
          </InlineAlert>
        ) : null}

        {items.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable so a keyboard can reach any overflow
            // (WCAG 2.2 2.1.1), matching the work list.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Your work, ranked"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Your open work across every project, {items.length} shown, overdue and due-soon
                first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Needs you</th>
                  <th scope="col">Title</th>
                  <th scope="col">State</th>
                  <th scope="col">Project</th>
                  <th scope="col">Due</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.workItem.id}>
                    <td>
                      <StateCapsule state={reasonCapsule(entry.reason)}>
                        {reasonLabel(entry.reason)}
                      </StateCapsule>
                    </td>
                    <th scope="row" className="tm-table__title">
                      <Link href={`/${organizationSlug}/work/${entry.workItem.id}`}>
                        {entry.workItem.title}
                      </Link>
                    </th>
                    <td>
                      <StateCapsule state={stateCapsule(entry.workItem.state)}>
                        {stateLabel(entry.workItem.state)}
                      </StateCapsule>
                    </td>
                    <td>{projectNames.get(entry.workItem.projectId) ?? 'Another project'}</td>
                    <td>{formatInstant(entry.workItem.dueAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

/** The word each ranking reason shows — the capsule is never colour alone. */
function reasonLabel(reason: MyDayReason): string {
  switch (reason) {
    case 'overdue':
      return 'Overdue';
    case 'due_soon':
      return 'Due soon';
    case 'assigned':
      return 'Assigned';
  }
}

function reasonCapsule(reason: MyDayReason): CapsuleState {
  switch (reason) {
    case 'overdue':
      return 'blocked';
    case 'due_soon':
      return 'waiting';
    case 'assigned':
      return 'neutral';
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your work loaded.';
  return 'Something went wrong loading your work.';
}
