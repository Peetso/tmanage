'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listClientRequests, listPortalProjects, listPortalWorkItems } from '../../lib/api/portal';
import type { ClientRequest, PortalProject, PortalWorkItem } from '../../lib/api/portal';
import {
  isWaitingOnClient,
  requestStatusCapsule,
  requestStatusLabel,
} from '../../lib/client-request-presentation';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ClientOverviewScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
  /** Injected in tests so "as of" is a fixed moment. */
  now?: Date;
}

/**
 * **CL-01 Client Overview.**
 *
 * `22-SCREEN-BY-SCREEN` §6: "First viewport: current milestone/forecast, latest update,
 * required actions, next date, shared risk. Freshness timestamp and project contact. **No
 * internal task percentage.**"
 *
 * ## The sentence in bold is the design
 *
 * There is no progress bar on this screen and there is no "60% complete". A percentage is
 * computed from internal task counts, and `12-PERMISSION-MATRIX` §4 excludes internal
 * estimates from the client projection — so a number here would either be a leak or a
 * fabrication. What the client gets instead is the two dates that mean something to them, the
 * things waiting on them, and when the page was last refreshed.
 *
 * The API cannot leak it either: `PortalWorkItem` has no state and no owner, so this screen
 * could not compute a task percentage if it wanted to.
 *
 * ## Required actions lead
 *
 * `waiting_on_you` items come first and are counted in the first viewport, because the whole
 * purpose of a client portal is that a client can tell, in one look, whether the project is
 * waiting on **them**. Everything else on this screen is context for that question.
 *
 * ## The freshness timestamp is about this page, not about the work
 *
 * "As of" names when the browser last received an answer. It is not `updatedAt` on anything:
 * a client looking at a stale tab needs to know the tab is stale, which is a different fact
 * from when the work last moved.
 */
export function ClientOverviewScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
  now = new Date(),
}: ClientOverviewScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const workItems = useQuery({
    queryKey: ['portal-work-items', organizationSlug],
    queryFn: () => listPortalWorkItems(api, organizationSlug),
  });

  /**
   * The client's own requests — `REQ-001`.
   *
   * On the overview rather than in the rail, because `22-SCREEN-BY-SCREEN` §1 fixes the client
   * navigation at seven destinations and "Requests" is not one of them. Asking for something is
   * reached from the page a client lands on instead; see `ClientRequestsScreen` for the record
   * of that divergence.
   */
  const requests = useQuery({
    queryKey: ['portal-requests', organizationSlug],
    queryFn: () => listClientRequests(api, organizationSlug),
  });

  const items = workItems.data ?? [];
  const waiting = items.filter((item) => item.progress === 'waiting_on_you');
  const project = projects.data?.[0];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="overview"
      title="Overview"
      description={`As of ${formatMoment(now)}`}
    >
      {projects.isError || workItems.isError ? (
        <InlineAlert tone="danger" title="Could not load your portal" live>
          {describe(projects.error ?? workItems.error)}
        </InlineAlert>
      ) : null}

      {projects.isPending || workItems.isPending ? (
        <LoadingRegion label="Loading your portal.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {/*
        Required actions first. §6 lists them third; they are rendered first because a client
        who has to scroll to find out that something is waiting on them has been told too late.
      */}
      <section className="tm-panel tm-stack" aria-labelledby="tm-portal-actions">
        <h2 id="tm-portal-actions" className="tm-eyebrow">
          Waiting on you
        </h2>
        {waiting.length === 0 ? (
          <p className="tm-prose">
            Nothing needs you right now. You will see anything that does here first, and{' '}
            {providerName} will tell you as well.
          </p>
        ) : (
          <ul className="tm-list tm-stack tm-stack--tight">
            {waiting.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>{' '}
                <StateCapsule state="client">Waiting on you</StateCapsule>{' '}
                <span className="tm-prose">{describeDue(item.dueAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {waiting.length > 0 ? (
          <p className="tm-prose">
            <Link href={`/${organizationSlug}/portal/actions`}>See all of your actions</Link>
          </p>
        ) : null}
      </section>

      {project ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-portal-dates">
          <h2 id="tm-portal-dates" className="tm-eyebrow">
            Where {project.name} stands
          </h2>
          <dl className="tm-detail-list">
            <div className="tm-detail-list__pair">
              <dt>Agreed date</dt>
              <dd>
                {project.committedAt === null
                  ? 'No date agreed yet'
                  : formatDay(project.committedAt)}
              </dd>
            </div>
            <div className="tm-detail-list__pair">
              <dt>Current estimate</dt>
              <dd>
                {project.forecastAt === null ? 'Not estimated yet' : formatDay(project.forecastAt)}
              </dd>
            </div>
          </dl>
          <p className="tm-prose">
            An <strong>agreed date</strong> is one {providerName} has committed to. A{' '}
            <strong>current estimate</strong> is where they expect to land today, and it can move.
            They are shown separately so a moving estimate is never mistaken for a broken promise.
          </p>
        </section>
      ) : null}

      <ProgressSection items={items} providerName={providerName} />

      <RequestsSection
        organizationSlug={organizationSlug}
        providerName={providerName}
        requests={requests.data ?? []}
      />

      <BackendPending ticket="updates, milestones and risks — unscheduled">
        The latest update from {providerName}, the milestone timeline, and shared risks are not
        built yet, and none of the three is scheduled to be. None is drawn as an empty section,
        because an empty “Updates” heading reads as a team that has said nothing rather than a
        feature that does not exist.
      </BackendPending>
    </ClientPortalShell>
  );
}

interface RequestsSectionProps {
  organizationSlug: string;
  providerName: string;
  requests: readonly ClientRequest[];
}

/**
 * What this client has asked for, and the way in to asking for something new.
 *
 * The entry point lives here because the rail cannot carry it: `22` §1's client navigation has
 * seven destinations and none of them is Requests. A client who has never asked for anything
 * still sees the invitation to — an empty section here is the only thing that tells them the
 * portal is two-way, and until `REQ-001` it genuinely was not.
 *
 * At most three are shown. A client with twenty requests needs the list, not the overview.
 */
function RequestsSection({ organizationSlug, providerName, requests }: RequestsSectionProps) {
  const waiting = requests.filter(isWaitingOnClient);
  // Anything the studio has asked about first, then the newest. Same rule as the full list.
  const recent = [...waiting, ...requests.filter((request) => !isWaitingOnClient(request))].slice(
    0,
    3,
  );

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-portal-requests">
      <h2 id="tm-portal-requests" className="tm-eyebrow">
        What you have asked for
      </h2>

      {requests.length === 0 ? (
        <p className="tm-prose">
          You have not asked {providerName} for anything yet. When you need something, ask here —
          they read it, ask you anything unclear, and either agree a date or tell you why not.
        </p>
      ) : (
        <ul className="tm-list tm-stack tm-stack--tight">
          {recent.map((request) => (
            <li key={request.id}>
              <Link href={`/${organizationSlug}/portal/requests/${request.id}`}>
                <strong>{request.title}</strong>
              </Link>{' '}
              <StateCapsule state={requestStatusCapsule(request.status)}>
                {requestStatusLabel(request.status)}
              </StateCapsule>
            </li>
          ))}
        </ul>
      )}

      <p className="tm-prose">
        <Link href={`/${organizationSlug}/portal/requests/new`}>Ask for something</Link>
        {' · '}
        <Link href={`/${organizationSlug}/portal/inbox`}>What has changed</Link>
        {requests.length > recent.length ? (
          <>
            {' · '}
            <Link href={`/${organizationSlug}/portal/requests`}>
              See all {requests.length} of your requests
            </Link>
          </>
        ) : requests.length > 0 ? (
          <>
            {' · '}
            <Link href={`/${organizationSlug}/portal/requests`}>See all of your requests</Link>
          </>
        ) : null}
      </p>
    </section>
  );
}

interface ProgressSectionProps {
  items: readonly PortalWorkItem[];
  providerName: string;
}

/**
 * What is moving, without a percentage.
 *
 * Counts of things a client can see, not a proportion of a task list they cannot. "4 of 9
 * finished" would still be an internal task count wearing a different hat; these are the
 * headings of work that was **published to this client**, which is a set they can read in full.
 */
function ProgressSection({ items, providerName }: ProgressSectionProps) {
  const inProgress = items.filter((item) => item.progress === 'in_progress');
  const done = items.filter((item) => item.progress === 'done');

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-portal-progress">
      <h2 id="tm-portal-progress" className="tm-eyebrow">
        What {providerName} is working on
      </h2>

      {items.length === 0 ? (
        <p className="tm-prose">
          Nothing has been shared with you yet. {providerName} decides what appears here, and they
          will tell you when something does.
        </p>
      ) : (
        <>
          {inProgress.length > 0 ? (
            <ul className="tm-list tm-stack tm-stack--tight">
              {inProgress.map((item) => (
                <li key={item.id}>
                  {item.title} <StateCapsule state="current">In progress</StateCapsule>{' '}
                  <span className="tm-prose">{describeDue(item.dueAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tm-prose">Nothing is in progress at the moment.</p>
          )}

          {done.length > 0 ? (
            <p className="tm-prose">
              {done.length === 1 ? 'One thing is' : `${done.length} things are`} finished.{' '}
              <StateCapsule state="done">Done</StateCapsule>
            </p>
          ) : null}
        </>
      )}

      {/*
        §6: "No internal task percentage." Said out loud rather than merely omitted, because a
        client who expects a progress bar and does not find one should know that is a decision.
      */}
      <p className="tm-field__hint">
        There is no percentage here on purpose. A percentage would be counted from
        {` ${providerName}'s`} internal task list, which is not what you are being shown — this is
        everything they have shared with you, in full.
      </p>
    </section>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}

function describeDue(value: string | null): string {
  return value === null ? 'No date' : `Due ${formatDay(value)}`;
}

function formatDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed);
}

function formatMoment(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  );
}

export type { PortalProject };
