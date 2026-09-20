'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomeSummary, getMyDay, getWaiting } from '../../lib/api/home';
import type { MyDayReason, WaitingReason } from '../../lib/api/home';
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
 * A hero summary (HOME-01) and two sections — Personal work (HOME-03) and Waiting (HOME-04). The
 * API does the ranking and names the reason per row for each, so this screen is a faithful reader
 * of those orders rather than a second place a rule could drift to. Waiting shows three buckets:
 * approvals pending on you as a reviewer, client requests awaiting your triage, and stale client
 * follow-ups; its delegated bucket is deferred (no assignee column on `work_items`). The hero's
 * counts are the API's derived summary, so it can show no number the sections below it do not. The
 * full editorial Pulse Track / Focus Capsule and Saved/pinned (HOME-05) are the later slices this
 * spine is built to carry; they are deliberately absent rather than stubbed.
 */
export function MyDayScreen({ organizationSlug, organizationName, client }: MyDayScreenProps) {
  const api = client ?? browserApiClient();

  const myDay = useQuery({
    queryKey: ['home', 'my-day', organizationSlug],
    queryFn: () => getMyDay(api, organizationSlug),
  });

  const waiting = useQuery({
    queryKey: ['home', 'waiting', organizationSlug],
    queryFn: () => getWaiting(api, organizationSlug),
  });

  const summary = useQuery({
    queryKey: ['home', 'summary', organizationSlug],
    queryFn: () => getHomeSummary(api, organizationSlug),
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
  const waitingItems = waiting.data?.items ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title="Home"
      description="What needs you today, across every project."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-my-day-hero">
        <h2 id="tm-my-day-hero" className="tm-eyebrow">
          Today at a glance
        </h2>

        {summary.isError ? (
          <InlineAlert tone="danger" title="Could not load your summary" live>
            {describeSummaryError(summary.error)}
          </InlineAlert>
        ) : null}

        {summary.isPending ? (
          <LoadingRegion label="Loading your summary.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!summary.isPending && !summary.isError && summary.data ? (
          <dl className="tm-detail-list" aria-label="Your day, in numbers">
            <div className="tm-detail-list__pair">
              <dt>Personal work</dt>
              <dd>
                {summary.data.personalWork.total} open
                {summary.data.personalWork.overdue > 0
                  ? `, ${summary.data.personalWork.overdue} overdue`
                  : ''}
                {summary.data.personalWork.dueSoon > 0
                  ? `, ${summary.data.personalWork.dueSoon} due soon`
                  : ''}
              </dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>Waiting on you</dt>
              <dd>
                {summary.data.waiting.total} waiting
                {summary.data.waiting.approvals > 0
                  ? `, ${summary.data.waiting.approvals} to review`
                  : ''}
                {summary.data.waiting.clientRequests > 0
                  ? `, ${summary.data.waiting.clientRequests} to triage`
                  : ''}
                {summary.data.waiting.staleFollowUps > 0
                  ? `, ${summary.data.waiting.staleFollowUps} to follow up`
                  : ''}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

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

      <section className="tm-panel tm-stack" aria-labelledby="tm-my-day-waiting">
        <h2 id="tm-my-day-waiting" className="tm-eyebrow">
          Waiting on you
        </h2>

        {waiting.isError ? (
          <InlineAlert tone="danger" title="Could not load what is waiting on you" live>
            {describeWaitingError(waiting.error)}
          </InlineAlert>
        ) : null}

        {waiting.isPending ? (
          <LoadingRegion label="Loading what is waiting on you.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!waiting.isPending && !waiting.isError && waitingItems.length === 0 ? (
          <InlineAlert tone="neutral" title="Nothing is waiting on you">
            You have no reviews pending and no client requests to triage. Approvals assigned to you,
            client requests awaiting your triage, and stale follow-ups across any project show up
            here, with what needs you first.
          </InlineAlert>
        ) : null}

        {waitingItems.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable so a keyboard can reach any overflow
            // (WCAG 2.2 2.1.1), matching the work list.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Waiting on you"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Approvals to review, client requests to triage and stale follow-ups across every
                project, {waitingItems.length} shown, what needs you first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Waiting on you</th>
                  <th scope="col">Item</th>
                  <th scope="col">Project</th>
                  <th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {waitingItems.map((entry) => (
                  <tr key={entry.kind === 'approval' ? entry.approvalId : entry.clientRequestId}>
                    <td>
                      <StateCapsule state={waitingReasonCapsule(entry.reason)}>
                        {waitingReasonLabel(entry.reason)}
                      </StateCapsule>
                    </td>
                    <th scope="row" className="tm-table__title">
                      {entry.kind === 'approval' ? 'Deliverable review' : entry.title}
                    </th>
                    <td>{projectNames.get(entry.projectId) ?? 'Another project'}</td>
                    <td>
                      {formatInstant(
                        entry.kind === 'approval' ? entry.requestedAt : entry.waitingSince,
                      )}
                    </td>
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

/** The word each waiting reason shows — the capsule is never colour alone. */
function waitingReasonLabel(reason: WaitingReason): string {
  switch (reason) {
    case 'approval_requested':
      return 'Review requested';
    case 'approval_viewed':
      return 'In review';
    case 'client_submitted':
      return 'New request';
    case 'client_triage':
      return 'In triage';
    case 'stale_follow_up':
      return 'Follow up';
  }
}

function waitingReasonCapsule(reason: WaitingReason): CapsuleState {
  switch (reason) {
    case 'approval_requested':
      return 'waiting';
    case 'approval_viewed':
      return 'neutral';
    case 'client_submitted':
      return 'waiting';
    case 'client_triage':
      return 'neutral';
    case 'stale_follow_up':
      return 'blocked';
  }
}

function describeWaitingError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your reviews loaded.';
  return 'Something went wrong loading what is waiting on you.';
}

function describeSummaryError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your summary loaded.';
  return 'Something went wrong loading your summary.';
}
