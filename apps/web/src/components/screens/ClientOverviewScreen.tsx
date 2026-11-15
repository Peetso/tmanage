'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clientOnlyRead, usePortalPreview } from '../../lib/portal-preview';
import { useHydrated } from '../../lib/use-hydrated';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { useSelectedPortalProject } from '../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listClientRequests,
  listPortalDeliverables,
  listPortalPeople,
  listPortalProjects,
  listPortalUpdates,
  listPortalWorkItems,
} from '../../lib/api/portal';
import type {
  ClientRequest,
  PortalDeliverable,
  PortalPerson,
  PortalProject,
  PortalUpdate,
  PortalWorkItem,
} from '../../lib/api/portal';
import { isWaitingOnClient, requestStatusLabel } from '../../lib/client-request-presentation';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { PortalJourneyStepper } from './PortalJourneyStepper';
import { Avatar, daysUntil, humanize, isPast, longDay, shortDay } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appLocale } from '../../lib/i18n/app-locale';

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
 * 52-27 journey stepper (published milestones plus the one review the client owes), the
 * client's own actions on the left with the next one in lime, and the latest update,
 * deliverables, requests and the team on the right.
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
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
  now: fixedNow,
}: ClientOverviewScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  // B8 (2026-11-07): the "As of" moment is the browser's, never the server render's — printing
  // it before hydration made the server and client text differ (React #418).
  const [loadedAt] = useState(() => new Date());
  const now = fixedNow ?? loadedAt;
  const hydrated = useHydrated();
  // B9: a staff preview cannot read the client's requests; say so instead of an empty list.
  const preview = usePortalPreview(organizationSlug);

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
  const queryClient = useQueryClient();
  // 2026-10-31 live-test fix: a staff preview reads the client's empty list, not the API's 403.
  const requests = useQuery({
    queryKey: ['portal-requests', organizationSlug],
    queryFn: () =>
      clientOnlyRead(queryClient, organizationSlug, [], () =>
        listClientRequests(api, organizationSlug),
      ),
  });

  const project = useSelectedPortalProject(projects.data);
  const firstProjectId = project?.id;

  /** Published updates only — the API decides visibility, this screen renders what it gets. */
  const updates = useQuery({
    queryKey: ['portal-updates', organizationSlug, firstProjectId],
    queryFn: () => listPortalUpdates(api, organizationSlug, firstProjectId!),
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
      title={project?.name ?? t('ClientOverviewScreen.overview')}
      eyebrow={eyebrowFor(project, tOr)}
      description={describeHeadline(project, actionCount, tOr)}
      headerAside={
        project ? (
          <HeaderMetrics project={project} waiting={waiting} questions={questions} now={now} />
        ) : undefined
      }
    >
      <div className="tm-pt">
        {projects.isError || workItems.isError ? (
          <InlineAlert tone="danger" title={t('ClientOverviewScreen.loadError')} live>
            {describe(projects.error ?? workItems.error)}
          </InlineAlert>
        ) : null}

        {projects.isPending || workItems.isPending ? (
          <LoadingRegion label={t('ClientOverviewScreen.loadingLabel')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {project ? (
          <PortalJourneyStepper
            api={api}
            organizationSlug={organizationSlug}
            projectId={project.id}
            providerName={providerName}
          />
        ) : !projects.isPending && !projects.isError ? (
          <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
            {t('ClientOverviewScreen.nothingSharedBefore')}
            {providerName}
            {t('ClientOverviewScreen.nothingSharedAfter')}
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
              preview={preview}
            />
            <TeamCard
              organizationSlug={organizationSlug}
              providerName={providerName}
              people={people.data ?? []}
            />
            {fixedNow !== undefined || hydrated ? (
              <p className="tm-pt-quiet">
                {t('ClientOverviewScreen.asOfPrefix')}
                {formatMoment(now)}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </ClientPortalShell>
  );
}

type TranslateOr = ReturnType<typeof useTOr>;

/** Fills `{name}` placeholders in a catalog string. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

// C4 (2026-11-07): the eyebrow and headline came from English literals, so the Arabic portal
// read "YOUR PROJECT" and "No date has been agreed yet". They come from the catalog now.
function eyebrowFor(project: PortalProject | undefined, tOr: TranslateOr): string | undefined {
  if (!project) return undefined;
  if (project.committedAt && project.forecastAt) {
    return project.forecastAt <= project.committedAt
      ? tOr('ClientOverviewScreen.eyebrowOnTrack', 'Your project · on track for the agreed date')
      : tOr(
          'ClientOverviewScreen.eyebrowLater',
          'Your project · estimate is later than the agreed date',
        );
  }
  return tOr('ClientOverviewScreen.eyebrowProject', 'Your project');
}

/**
 * B7 (2026-11-07): the project's agreed date is the *launch* date. Saying only "No date has been
 * agreed yet" read as a contradiction of the stage dates the timeline shows as committed, so the
 * missing date is named for what it is.
 */
function describeHeadline(
  project: PortalProject | undefined,
  actions: number,
  tOr: TranslateOr,
): string | undefined {
  if (!project) return undefined;
  const toward = project.committedAt
    ? fill(tOr('ClientOverviewScreen.headlineToward', 'Everything is moving toward {date}.'), {
        date: longDay(project.committedAt),
      })
    : tOr('ClientOverviewScreen.headlineNoLaunchDate', 'No launch date has been agreed yet.');
  const needed =
    actions === 0
      ? tOr('ClientOverviewScreen.headlineNothingNeeded', 'Nothing is needed from you right now.')
      : actions === 1
        ? tOr('ClientOverviewScreen.headlineOneNeeded', 'One thing from you is needed.')
        : fill(
            tOr('ClientOverviewScreen.headlineManyNeeded', '{count} things from you are needed.'),
            { count: actions },
          );
  return `${toward} ${needed}`;
}

interface HeaderMetricsProps {
  project: PortalProject;
  waiting: readonly PortalWorkItem[];
  questions: readonly ClientRequest[];
  now: Date;
}

/** CL-01's two numbers: days to the agreed date, and how many things wait on the client. */
function HeaderMetrics({ project, waiting, questions, now }: HeaderMetricsProps) {
  const t = useT();
  const tOr = useTOr();
  const days = daysUntil(project.committedAt, now);
  const count = waiting.length + questions.length;
  const soon = waiting.some((item) => {
    const left = daysUntil(item.dueAt, now);
    return left !== null && left <= 7;
  });
  const next = waiting.find((item) => item.dueAt !== null);

  return (
    <div className="tm-pt-metrics">
      <section className="tm-pt-metric" aria-label={t('ClientOverviewScreen.datesLabel')}>
        <p className="tm-pt-metric__value">{days ?? '—'}</p>
        <p className="tm-pt-metric__label">
          {days === null
            ? tOr('ClientOverviewScreen.noLaunchDateAgreed', 'No launch date agreed yet')
            : days === 1
              ? t('ClientOverviewScreen.dayToLaunch')
              : t('ClientOverviewScreen.daysToLaunch')}
        </p>
        <dl className="tm-pt-metric__source">
          {/* 2026-10-31 live-test fix (Figma 446:37676): with no agreed date the label above
              already says so; "Agreed date · not agreed yet" under it said it twice. */}
          {project.committedAt ? (
            <div>
              <dt>{t('ClientOverviewScreen.agreedDate')}</dt>{' '}
              <dd>{shortDay(project.committedAt)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t('ClientOverviewScreen.currentEstimate')}</dt>{' '}
            <dd>
              {project.forecastAt
                ? shortDay(project.forecastAt)
                : t('ClientOverviewScreen.notEstimatedYet')}
            </dd>
          </div>
        </dl>
      </section>
      <section className="tm-pt-metric" aria-label={t('ClientOverviewScreen.waitingForYou')}>
        <div className="tm-pt-metric__row">
          <p className="tm-pt-metric__value">{count}</p>
          {soon ? (
            <span className="tm-pt-metric__pill">{t('ClientOverviewScreen.thisWeek')}</span>
          ) : null}
        </div>
        <p className="tm-pt-metric__label">
          {count === 1
            ? t('ClientOverviewScreen.actionWaiting')
            : t('ClientOverviewScreen.actionsWaiting')}
        </p>
        <p className="tm-pt-metric__source">
          {next?.dueAt
            ? `${t('ClientOverviewScreen.nextDuePrefix')}${shortDay(next.dueAt)}`
            : count === 0
              ? t('ClientOverviewScreen.allCaughtUp')
              : ''}
        </p>
      </section>
    </div>
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
  const t = useT();
  const [first, ...rest] = waiting;
  const nothing = waiting.length === 0 && questions.length === 0;

  return (
    <section className="tm-pt-col" aria-labelledby="tm-portal-actions">
      <h2 id="tm-portal-actions" className="tm-pt-section-title">
        {t('ClientOverviewScreen.yourActions')}
      </h2>

      {first ? (
        <article className="tm-pt-feature">
          <div className="tm-pt-feature__top">
            <p className="tm-pt-eyebrow">
              {t('ClientOverviewScreen.needsYou')}
              {first.dueAt ? ` · ${t('ClientOverviewScreen.byLower')}${shortDay(first.dueAt)}` : ''}
            </p>
            {first.dueAt ? (
              <span className="tm-pt-feature__due">
                {isPast(first.dueAt, now)
                  ? t('ClientOverviewScreen.pastItsDate')
                  : `${t('ClientOverviewScreen.duePrefix')}${shortDay(first.dueAt)}`}
              </span>
            ) : null}
          </div>
          <h3 className="tm-pt-feature__title">{first.title}</h3>
          <p className="tm-pt-feature__text">
            {providerName}
            {t('ClientOverviewScreen.waitingSuffix')}
          </p>
          <div className="tm-pt-feature__actions">
            <Link className="tm-pt-btn tm-pt-btn--orb" href={`/${organizationSlug}/portal/actions`}>
              <span className="tm-pt-btn__orb" aria-hidden="true">
                ▸
              </span>
              {t('ClientOverviewScreen.seeAllActions')}
            </Link>
            <Link className="tm-pt-link" href={`/${organizationSlug}/portal/requests/new`}>
              {t('ClientOverviewScreen.askQuestionInstead')}
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
                  ? `${isPast(item.dueAt, now) ? t('ClientOverviewScreen.wasDue') : t('ClientOverviewScreen.neededBy')} ${longDay(item.dueAt)}`
                  : t('ClientOverviewScreen.noDateSet')}
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
                  `${providerName}${t('ClientOverviewScreen.askedSomethingSuffix')}`}
              </p>
            </div>
            <Link
              className="tm-pt-btn"
              href={`/${organizationSlug}/portal/requests/${request.id}`}
              aria-label={`${t('ClientOverviewScreen.replyPrefix')}${request.title}`}
            >
              {t('ClientOverviewScreen.reply')}
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
              ? `${t('ClientOverviewScreen.nothingNeedsBefore')}${providerName}${t('ClientOverviewScreen.nothingNeedsAfter')}`
              : t('ClientOverviewScreen.afterThatNote')}
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
  const describe = useDescribeApiError(PORTAL_LINES);
  const t = useT();
  const latest = updates[0];
  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-updates">
      <div className="tm-pt-card__head">
        <h2 id="tm-portal-updates" className="tm-pt-card__title">
          {t('ClientOverviewScreen.latestUpdate')}
        </h2>
        {latest ? (
          <time className="tm-pt-mono" dateTime={latest.createdAt}>
            {shortDay(latest.createdAt)}
          </time>
        ) : null}
      </div>
      {isError ? (
        <InlineAlert tone="danger" title={t('ClientOverviewScreen.updatesError')} live>
          {describe(error)}
        </InlineAlert>
      ) : latest ? (
        <>
          <p className="tm-pt-item__title">{latest.title}</p>
          <p className="tm-pt-card__body">“{latest.body}”</p>
          <Link className="tm-pt-link" href={`/${organizationSlug}/portal/updates`}>
            {t('ClientOverviewScreen.allUpdates')}
          </Link>
        </>
      ) : (
        <p className="tm-pt-card__body">
          {providerName}
          {t('ClientOverviewScreen.noUpdateSuffix')}
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
  const t = useT();
  const shown = deliverables.slice(0, 3);
  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-deliverables">
      <h2 id="tm-portal-deliverables" className="tm-pt-card__title">
        {t('ClientOverviewScreen.deliverables')}
      </h2>
      {shown.length === 0 ? (
        <p className="tm-pt-card__body">
          {providerName}
          {t('ClientOverviewScreen.noDeliverableSuffix')}
        </p>
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
                        : `${t('ClientOverviewScreen.sharedPrefix')}${shortDay(deliverable.publishedAt)}`}
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
  preview,
}: {
  organizationSlug: string;
  providerName: string;
  requests: readonly ClientRequest[];
  preview: boolean;
}) {
  const t = useT();
  const tOr = useTOr();
  const waiting = requests.filter(isWaitingOnClient);
  const recent = [...waiting, ...requests.filter((request) => !isWaitingOnClient(request))].slice(
    0,
    3,
  );

  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-requests">
      <h2 id="tm-portal-requests" className="tm-pt-card__title">
        {t('ClientOverviewScreen.whatAskedFor')}
      </h2>

      {preview ? (
        <p className="tm-pt-card__body">
          {tOr(
            'ClientOverviewScreen.requestsPreview',
            'Requests are not available in the staff preview. Only someone from the client can see and send them.',
          )}
        </p>
      ) : requests.length === 0 ? (
        <p className="tm-pt-card__body">
          {t('ClientOverviewScreen.noRequestsBefore')}
          {providerName}
          {t('ClientOverviewScreen.noRequestsAfter')}
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
        <Link href={`/${organizationSlug}/portal/requests/new`}>
          {t('ClientOverviewScreen.askForSomething')}
        </Link>
        {' · '}
        <Link href={`/${organizationSlug}/portal/inbox`}>
          {t('ClientOverviewScreen.whatHasChanged')}
        </Link>
        {requests.length > recent.length ? (
          <>
            {' · '}
            <Link href={`/${organizationSlug}/portal/requests`}>
              {fill(
                tOr('ClientOverviewScreen.seeAllCountRequests', 'See all {count} of your requests'),
                { count: requests.length },
              )}
            </Link>
          </>
        ) : requests.length > 0 ? (
          <>
            {' · '}
            <Link href={`/${organizationSlug}/portal/requests`}>
              {t('ClientOverviewScreen.seeAllRequests')}
            </Link>
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
  const t = useT();
  if (people.length === 0) return null;
  return (
    <section className="tm-pt-card" aria-labelledby="tm-portal-team">
      <h2 id="tm-portal-team" className="tm-pt-card__title">
        {t('ClientOverviewScreen.yourTeamAtPrefix')}
        {providerName}
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
          {t('ClientOverviewScreen.everyoneOnProject')}
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

function formatMoment(value: Date): string {
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  );
}

export type { PortalProject };
