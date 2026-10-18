'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listClientRequests,
  listPortalDeliverables,
  listPortalMilestones,
  listPortalPeople,
  listPortalProjects,
  listPortalUpdates,
  listPortalWorkItems,
} from '../../lib/api/portal';
import type {
  ClientMilestone,
  ClientRequest,
  PortalDeliverable,
  PortalPerson,
  PortalProject,
  PortalUpdate,
  PortalWorkItem,
} from '../../lib/api/portal';
import { isWaitingOnClient, requestStatusLabel } from '../../lib/client-request-presentation';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { Avatar, daysUntil, humanize, isPast, longDay, shortDay } from './PortalParts';

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
 * **CL-01 Client Overview** — "understand progress in 30 seconds".
 *
 * `22-SCREEN-BY-SCREEN` §6: "First viewport: current milestone/forecast, latest update, required
 * actions, next date, shared risk. Freshness timestamp and project contact. **No internal task
 * percentage.**"
 *
 * Laid out as the handoff draws it: the project name as the display headline with the two
 * numbers that matter to a client beside it (days to the agreed date, actions waiting), the
 * journey pulse track built from the milestones the studio published, the client's own actions
 * on the left with the next one in lime, and the latest update, deliverables, requests and the
 * team on the right.
 *
 * There is still no percentage anywhere. `PortalWorkItem` has no state and no owner, so a task
 * percentage could not be computed even if the screen wanted one; the track is the published
 * milestones, which the client can read in full.
 *
 * The agreed date and the current estimate stay two separate facts, labelled separately, so a
 * moving estimate is never mistaken for a broken promise.
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
   * The client's own requests — `REQ-001`. On the overview rather than in the bar, because `22`
   * §1 fixes the client navigation and "Requests" is not one of its destinations.
   */
  const requests = useQuery({
    queryKey: ['portal-requests', organizationSlug],
    queryFn: () => listClientRequests(api, organizationSlug),
  });

  const project = projects.data?.[0];
  const firstProjectId = project?.id;

  /** Published updates only — the API decides visibility, this screen renders what it gets. */
  const updates = useQuery({
    queryKey: ['portal-updates', organizationSlug, firstProjectId],
    queryFn: () => listPortalUpdates(api, organizationSlug, firstProjectId!),
    enabled: firstProjectId != null,
  });

  const milestones = useQuery({
    queryKey: ['portal-milestones', organizationSlug, firstProjectId],
    queryFn: () => listPortalMilestones(api, organizationSlug, firstProjectId!),
    enabled: firstProjectId != null,
  });

  const deliverables = useQuery({
    queryKey: ['portal-deliverables', organizationSlug, firstProjectId],
    queryFn: () => listPortalDeliverables(api, organizationSlug, firstProjectId!),
    enabled: firstProjectId != null,
  });

  const people = useQuery({
    queryKey: ['portal-people', organizationSlug, firstProjectId],
    queryFn: () => listPortalPeople(api, organizationSlug, firstProjectId!),
    enabled: firstProjectId != null,
  });

  const items = workItems.data ?? [];
  const waiting = items.filter((item) => item.progress === 'waiting_on_you').sort(byDueDate);
  const questions = (requests.data ?? []).filter(isWaitingOnClient);
  const actionCount = waiting.length + questions.length;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="overview"
      title={project?.name ?? 'Overview'}
      eyebrow={eyebrowFor(project)}
      description={describeHeadline(project, actionCount)}
      headerAside={
        project ? (
          <HeaderMetrics project={project} waiting={waiting} questions={questions} now={now} />
        ) : undefined
      }
    >
      <div className="tm-pt">
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

        {project ? (
          <JourneyTrack
            organizationSlug={organizationSlug}
            providerName={providerName}
            milestones={milestones.data ?? []}
            hasSharedWork={items.length > 0}
          />
        ) : !projects.isPending && !projects.isError ? (
          <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
            Nothing has been shared with you yet. {providerName} decides what appears here, and they
            will tell you when something does.
          </p>
        ) : null}

        <div className="tm-pt-split">
          <ActionsColumn
            organizationSlug={organizationSlug}
            providerName={providerName}
            waiting={waiting}
            questions={questions}
            now={now}
          />

          <div className="tm-pt-col">
            <LatestUpdateCard
              organizationSlug={organizationSlug}
              providerName={providerName}
              updates={updates.data ?? []}
              isError={updates.isError}
              error={updates.error}
            />
            <DeliverablesCard
              organizationSlug={organizationSlug}
              providerName={providerName}
              deliverables={deliverables.data ?? []}
            />
            <RequestsCard
              organizationSlug={organizationSlug}
              providerName={providerName}
              requests={requests.data ?? []}
            />
            <TeamCard
              organizationSlug={organizationSlug}
              providerName={providerName}
              people={people.data ?? []}
            />
            <p className="tm-pt-quiet">As of {formatMoment(now)}</p>
          </div>
        </div>
      </div>
    </ClientPortalShell>
  );
}

function eyebrowFor(project: PortalProject | undefined): string | undefined {
  if (!project) return undefined;
  if (project.committedAt && project.forecastAt) {
    return project.forecastAt <= project.committedAt
      ? 'Your project · on track for the agreed date'
      : 'Your project · estimate is later than the agreed date';
  }
  return 'Your project';
}

function describeHeadline(project: PortalProject | undefined, actions: number): string | undefined {
  if (!project) return undefined;
  const toward = project.committedAt
    ? `Everything is moving toward ${longDay(project.committedAt)}.`
    : 'No date has been agreed yet.';
  const needed =
    actions === 0
      ? ' Nothing is needed from you right now.'
      : actions === 1
        ? ' One thing from you is needed.'
        : ` ${actions} things from you are needed.`;
  return `${toward}${needed}`;
}

interface HeaderMetricsProps {
  project: PortalProject;
  waiting: readonly PortalWorkItem[];
  questions: readonly ClientRequest[];
  now: Date;
}

/** CL-01's two numbers: days to the agreed date, and how many things wait on the client. */
function HeaderMetrics({ project, waiting, questions, now }: HeaderMetricsProps) {
  const days = daysUntil(project.committedAt, now);
  const count = waiting.length + questions.length;
  const soon = waiting.some((item) => {
    const left = daysUntil(item.dueAt, now);
    return left !== null && left <= 7;
  });
  const next = waiting.find((item) => item.dueAt !== null);

  return (
    <div className="tm-pt-metrics">
      <section className="tm-pt-metric" aria-label="Dates">
        <p className="tm-pt-metric__value">{days ?? '—'}</p>
        <p className="tm-pt-metric__label">
          {days === null ? 'No date agreed yet' : days === 1 ? 'day to launch' : 'days to launch'}
        </p>
        <dl className="tm-pt-metric__source">
          <div>
            <dt>Agreed date</dt>{' '}
            <dd>{project.committedAt ? shortDay(project.committedAt) : 'not agreed yet'}</dd>
          </div>
          <div>
            <dt>Current estimate</dt>{' '}
            <dd>{project.forecastAt ? shortDay(project.forecastAt) : 'not estimated yet'}</dd>
          </div>
        </dl>
      </section>
      <section className="tm-pt-metric" aria-label="Waiting for you">
        <div className="tm-pt-metric__row">
          <p className="tm-pt-metric__value">{count}</p>
          {soon ? <span className="tm-pt-metric__pill">this week</span> : null}
        </div>
        <p className="tm-pt-metric__label">
          {count === 1 ? 'action waiting for you' : 'actions waiting for you'}
        </p>
        <p className="tm-pt-metric__source">
          {next?.dueAt ? `next due ${shortDay(next.dueAt)}` : count === 0 ? 'all caught up' : ''}
        </p>
      </section>
    </div>
  );
}

interface JourneyTrackProps {
  organizationSlug: string;
  providerName: string;
  milestones: readonly ClientMilestone[];
  hasSharedWork: boolean;
}

/** The pulse track: finished milestones in ink, the current one in lime, the rest ahead. */
function JourneyTrack({
  organizationSlug,
  providerName,
  milestones,
  hasSharedWork,
}: JourneyTrackProps) {
  const ordered = [...milestones].sort(byDueOn);
  const nowIndex = ordered.findIndex((milestone) => milestone.status !== 'met');

  return (
    <section className="tm-stack tm-stack--tight" aria-labelledby="tm-portal-track">
      <div className="tm-pt-track-head">
        <h2 id="tm-portal-track" className="tm-pt-eyebrow">
          Where the project is
        </h2>
        {ordered.length > 0 ? (
          <p className="tm-pt-quiet">
            {nowIndex === -1
              ? `all ${ordered.length} stages done`
              : `stage ${nowIndex + 1} of ${ordered.length}`}{' '}
            · <Link href={`/${organizationSlug}/portal/timeline`}>see the full timeline</Link>
          </p>
        ) : null}
      </div>

      {ordered.length === 0 ? (
        <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
          {hasSharedWork
            ? `${providerName} has not shared the stages of this project yet. They will appear here as soon as they do.`
            : `Nothing has been shared with you yet. ${providerName} decides what appears here, and they will tell you when something does.`}
        </p>
      ) : (
        <ol className="tm-pt-track">
          {ordered.map((milestone, index) => (
            <TrackStep
              key={milestone.id}
              milestone={milestone}
              position={
                index < nowIndex || nowIndex === -1 ? 'done' : index === nowIndex ? 'now' : 'ahead'
              }
              last={index === ordered.length - 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function TrackStep({
  milestone,
  position,
  last,
}: {
  milestone: ClientMilestone;
  position: 'done' | 'now' | 'ahead';
  last: boolean;
}) {
  if (position === 'done' || milestone.status === 'met') {
    return (
      <li className="tm-pt-step tm-pt-step--done">
        <span className="tm-pt-step__check" aria-hidden="true">
          ✓
        </span>
        <span className="tm-pt-step__text">
          <span className="tm-pt-step__name">{milestone.title}</span>
          <span className="tm-pt-step__date">
            done{milestone.dueOn ? ` ${shortDay(milestone.dueOn)}` : ''}
          </span>
        </span>
      </li>
    );
  }

  if (position === 'now') {
    return (
      <li className="tm-pt-step tm-pt-step--now" aria-current="step">
        <span className="tm-pt-step__text">
          <span className="tm-pt-step__kicker">Now</span>
          <span className="tm-pt-step__name">{milestone.title}</span>
        </span>
        <span className="tm-pt-step__end">
          <span className="tm-pt-step__date">
            {milestone.status === 'missed'
              ? 'date missed'
              : milestone.dueOn
                ? `by ${shortDay(milestone.dueOn)}`
                : 'no date yet'}
          </span>
        </span>
      </li>
    );
  }

  const undated = milestone.dueOn === null;
  return (
    <li
      className={[
        'tm-pt-step',
        undated || last ? 'tm-pt-step--future' : 'tm-pt-step--grow',
        milestone.status === 'missed' ? 'tm-pt-step--late' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="tm-pt-step__text">
        <span className="tm-pt-step__name">{milestone.title}</span>
        <span className="tm-pt-step__date">
          {undated ? 'no date yet' : shortDay(milestone.dueOn)}
        </span>
      </span>
    </li>
  );
}

interface ActionsColumnProps {
  organizationSlug: string;
  providerName: string;
  waiting: readonly PortalWorkItem[];
  questions: readonly ClientRequest[];
  now: Date;
}

/**
 * Required actions lead. `waiting_on_you` work first — the soonest in the lime card — then any
 * question the studio asked on a request, then the confirmation of what happens after.
 */
function ActionsColumn({
  organizationSlug,
  providerName,
  waiting,
  questions,
  now,
}: ActionsColumnProps) {
  const [first, ...rest] = waiting;
  const nothing = waiting.length === 0 && questions.length === 0;

  return (
    <section className="tm-pt-col" aria-labelledby="tm-portal-actions">
      <h2 id="tm-portal-actions" className="tm-pt-section-title">
        Your actions
      </h2>

      {first ? (
        <article className="tm-pt-feature">
          <div className="tm-pt-feature__top">
            <p className="tm-pt-eyebrow">
              Needs you{first.dueAt ? ` · by ${shortDay(first.dueAt)}` : ''}
            </p>
            {first.dueAt ? (
              <span className="tm-pt-feature__due">
                {isPast(first.dueAt, now) ? 'Past its date' : `Due ${shortDay(first.dueAt)}`}
              </span>
            ) : null}
          </div>
          <h3 className="tm-pt-feature__title">{first.title}</h3>
          <p className="tm-pt-feature__text">
            {providerName} is waiting on you for this. It is the soonest thing on your list.
          </p>
          <div className="tm-pt-feature__actions">
            <Link className="tm-pt-btn tm-pt-btn--orb" href={`/${organizationSlug}/portal/actions`}>
              <span className="tm-pt-btn__orb" aria-hidden="true">
                ▸
              </span>
              See all of your actions
            </Link>
            <Link className="tm-pt-link" href={`/${organizationSlug}/portal/requests/new`}>
              Ask a question instead
            </Link>
          </div>
        </article>
      ) : null}

      {rest.map((item) => (
        <article key={item.id} className="tm-pt-card tm-pt-card--lg">
          <div className="tm-pt-aside-row">
            <span className="tm-pt-orb tm-pt-orb--md" aria-hidden="true">
              !
            </span>
            <div className="tm-pt-item__main">
              <h3 className="tm-pt-card__title">{item.title}</h3>
              <p className="tm-pt-quiet">
                {item.dueAt
                  ? `${isPast(item.dueAt, now) ? 'Was due' : 'Needed by'} ${longDay(item.dueAt)}`
                  : 'No date has been set for this.'}
              </p>
            </div>
          </div>
        </article>
      ))}

      {questions.map((request) => (
        <article key={request.id} className="tm-pt-card tm-pt-card--lg">
          <div className="tm-pt-aside-row">
            <span className="tm-pt-orb tm-pt-orb--md" aria-hidden="true">
              ?
            </span>
            <div className="tm-pt-item__main">
              <h3 className="tm-pt-card__title">{request.title}</h3>
              <p className="tm-pt-quiet">
                {request.clarificationQuestion ??
                  `${providerName} has asked you something about this request.`}
              </p>
            </div>
            <Link
              className="tm-pt-btn"
              href={`/${organizationSlug}/portal/requests/${request.id}`}
              aria-label={`Reply: ${request.title}`}
            >
              Reply
            </Link>
          </div>
        </article>
      ))}

      <div className="tm-pt-card tm-pt-card--dashed">
        <div className="tm-pt-aside-row">
          <span className="tm-pt-orb" aria-hidden="true">
            ✓
          </span>
          <p className="tm-pt-card__body tm-pt-item__main">
            {nothing
              ? `Nothing needs you right now. You will see anything that does here first, and ${providerName} will tell you as well.`
              : 'After that, nothing else is needed from you. We’ll notify you when your review, file, or answer is needed.'}
          </p>
        </div>
      </div>
    </section>
  );
}

function LatestUpdateCard({
  organizationSlug,
  providerName,
  updates,
  isError,
  error,
}: {
  organizationSlug: string;
  providerName: string;
  updates: readonly PortalUpdate[];
  isError: boolean;
  error: unknown;
}) {
  const latest = updates[0];
  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-updates">
      <div className="tm-pt-card__head">
        <h2 id="tm-portal-updates" className="tm-pt-card__title">
          Latest update
        </h2>
        {latest ? (
          <time className="tm-pt-mono" dateTime={latest.createdAt}>
            {shortDay(latest.createdAt)}
          </time>
        ) : null}
      </div>
      {isError ? (
        <InlineAlert tone="danger" title="Could not load updates" live>
          {describe(error)}
        </InlineAlert>
      ) : latest ? (
        <>
          <p className="tm-pt-item__title">{latest.title}</p>
          <p className="tm-pt-card__body">“{latest.body}”</p>
          <Link className="tm-pt-link" href={`/${organizationSlug}/portal/updates`}>
            All updates
          </Link>
        </>
      ) : (
        <p className="tm-pt-card__body">
          {providerName} has not posted an update yet. When they share news about your project, it
          will appear here, newest first.
        </p>
      )}
    </section>
  );
}

function DeliverablesCard({
  organizationSlug,
  providerName,
  deliverables,
}: {
  organizationSlug: string;
  providerName: string;
  deliverables: readonly PortalDeliverable[];
}) {
  const shown = deliverables.slice(0, 3);
  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-deliverables">
      <h2 id="tm-portal-deliverables" className="tm-pt-card__title">
        Deliverables
      </h2>
      {shown.length === 0 ? (
        <p className="tm-pt-card__body">{providerName} has not published a deliverable yet.</p>
      ) : (
        <ul className="tm-pt-files">
          {shown.map((deliverable) => {
            const decided = deliverable.decision !== null;
            return (
              <li key={deliverable.id} className="tm-pt-item">
                <span
                  className={decided ? 'tm-pt-orb tm-pt-orb--done' : 'tm-pt-orb tm-pt-orb--lime'}
                  aria-hidden="true"
                >
                  {decided ? '✓' : '▸'}
                </span>
                <div className="tm-pt-item__main">
                  <p className="tm-pt-item__title">
                    <Link href={`/${organizationSlug}/portal/deliverables/${deliverable.id}`}>
                      {deliverable.title}
                    </Link>
                  </p>
                  <p className="tm-pt-mono">
                    {decided
                      ? humanize(deliverable.decision!)
                      : deliverable.milestoneState
                        ? humanize(deliverable.milestoneState)
                        : `Shared ${shortDay(deliverable.publishedAt)}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * What this client has asked for, and the way in to asking for something new. The bar cannot
 * carry it (`22` §1), so the overview is the door. At most three are shown.
 */
function RequestsCard({
  organizationSlug,
  providerName,
  requests,
}: {
  organizationSlug: string;
  providerName: string;
  requests: readonly ClientRequest[];
}) {
  const waiting = requests.filter(isWaitingOnClient);
  const recent = [...waiting, ...requests.filter((request) => !isWaitingOnClient(request))].slice(
    0,
    3,
  );

  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-requests">
      <h2 id="tm-portal-requests" className="tm-pt-card__title">
        What you have asked for
      </h2>

      {requests.length === 0 ? (
        <p className="tm-pt-card__body">
          You have not asked {providerName} for anything yet. When you need something, ask here —
          they read it, ask you anything unclear, and either agree a date or tell you why not.
        </p>
      ) : (
        <ul className="tm-pt-files">
          {recent.map((request) => (
            <li key={request.id} className="tm-pt-item">
              <div className="tm-pt-item__main">
                <p className="tm-pt-item__title">
                  <Link href={`/${organizationSlug}/portal/requests/${request.id}`}>
                    {request.title}
                  </Link>
                </p>
                <p className="tm-pt-mono">{requestStatusLabel(request.status)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="tm-pt-quiet">
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

function TeamCard({
  organizationSlug,
  providerName,
  people,
}: {
  organizationSlug: string;
  providerName: string;
  people: readonly PortalPerson[];
}) {
  if (people.length === 0) return null;
  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-team">
      <h2 id="tm-portal-team" className="tm-pt-card__title">
        Your team at {providerName.split(' ')[0]}
      </h2>
      <ul className="tm-chip-row">
        {people.slice(0, 4).map((person) => (
          <li key={`${person.displayName}:${person.role}`} className="tm-pt-person">
            <Avatar name={person.displayName} />
            {person.displayName.split(' ')[0]} · {humanize(person.role)}
          </li>
        ))}
      </ul>
      {people.length > 4 ? (
        <Link className="tm-pt-link" href={`/${organizationSlug}/portal/people`}>
          Everyone on the project
        </Link>
      ) : null}
    </section>
  );
}

/** Undated last: a missing date is not urgency, and sorting it first would invent some. */
function byDueDate(left: PortalWorkItem, right: PortalWorkItem): number {
  if (left.dueAt === right.dueAt) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt < right.dueAt ? -1 : 1;
}

function byDueOn(left: ClientMilestone, right: ClientMilestone): number {
  if (left.dueOn === right.dueOn) return 0;
  if (left.dueOn === null) return 1;
  if (right.dueOn === null) return -1;
  return left.dueOn < right.dueOn ? -1 : 1;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}

function formatMoment(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  );
}

export type { PortalProject };
