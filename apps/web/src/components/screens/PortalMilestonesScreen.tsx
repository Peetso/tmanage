'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalMilestones, listPortalProjects, listPortalRisks } from '../../lib/api/portal';
import type { ClientMilestone, ClientRisk, MilestoneStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { longDay, shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';

export interface PortalMilestonesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **CL-04 Timeline** — the client journey pulse track, dates labelled by kind.
 *
 * The published milestones of the client's first shared project (`ClientMilestone`: title, due
 * date, planned/met/missed — never an internal estimate). Drawn as the handoff's CL-04: the
 * milestones as tall track blocks — done in ink, the current one in lime, the rest ahead, an
 * undated one dashed — then every date in order on the left and, in the inverted card, what
 * could put the launch at risk, read from the risks the studio published to the client.
 */
export function PortalMilestonesScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalMilestonesScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = projects.data?.[0];
  const projectId = project?.id;

  const milestones = useQuery({
    queryKey: ['portal-milestones', organizationSlug, projectId],
    queryFn: () => listPortalMilestones(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const risks = useQuery({
    queryKey: ['portal-risks', organizationSlug, projectId],
    queryFn: () => listPortalRisks(api, organizationSlug, projectId!),
    enabled: projectId != null,
  });

  const ordered = [...(milestones.data ?? [])].sort(byDueOn);
  const dated = ordered.filter((milestone) => milestone.dueOn !== null);
  const target = project?.committedAt ?? dated[dated.length - 1]?.dueOn ?? null;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="timeline"
      title={target ? `How the project reaches ${longDay(target)}` : 'Timeline'}
      eyebrow={eyebrowFor(dated)}
      headerAside={ordered.length > 0 ? <Legend /> : undefined}
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title="Could not load your portal" live>
            {describe(projects.error)}
          </InlineAlert>
        ) : null}

        {projects.isPending ? (
          <LoadingRegion label="Loading your project">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : (
          <MilestonesSection
            organizationSlug={organizationSlug}
            providerName={providerName}
            milestones={ordered}
            risks={(risks.data ?? []).filter((risk) => risk.status === 'open')}
            isPending={milestones.isPending && projectId != null}
            isError={milestones.isError}
            error={milestones.error}
            hasProject={projectId != null}
          />
        )}
      </div>
    </ClientPortalShell>
  );
}

function eyebrowFor(dated: readonly ClientMilestone[]): string {
  if (dated.length === 0) return 'Timeline';
  const month = (value: string | null) =>
    value ? new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date(value)) : '';
  const first = month(dated[0]!.dueOn);
  const last = month(dated[dated.length - 1]!.dueOn);
  return first === last ? `Timeline · ${first}` : `Timeline · ${first} to ${last}`;
}

function Legend() {
  return (
    <ul className="tm-pt-legend" aria-label="Key">
      <li>
        <span className="tm-pt-legend__dot tm-pt-legend__dot--done" aria-hidden="true" />
        done
      </li>
      <li>
        <span className="tm-pt-legend__dot tm-pt-legend__dot--now" aria-hidden="true" />
        now
      </li>
      <li>
        <span className="tm-pt-legend__dot" aria-hidden="true" />
        committed date
      </li>
      <li>
        <span className="tm-pt-legend__dot tm-pt-legend__dot--none" aria-hidden="true" />
        no date yet
      </li>
    </ul>
  );
}

interface MilestonesSectionProps {
  organizationSlug: string;
  providerName: string;
  milestones: readonly ClientMilestone[];
  risks: readonly ClientRisk[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasProject: boolean;
}

function MilestonesSection({
  organizationSlug,
  providerName,
  milestones,
  risks,
  isPending,
  isError,
  error,
  hasProject,
}: MilestonesSectionProps) {
  if (!hasProject) {
    return (
      <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
        There is no project shared with you yet. When {providerName} shares one, its milestones will
        appear here.
      </p>
    );
  }
  if (isError) {
    return (
      <InlineAlert tone="danger" title="Could not load milestones" live>
        {describe(error)}
      </InlineAlert>
    );
  }
  if (isPending) {
    return (
      <LoadingRegion label="Loading milestones">
        <Skeleton height="var(--row)" />
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (milestones.length === 0) {
    return (
      <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
        {providerName} has not published a milestone yet. When they set the dates for your project,
        they will appear here in order.
      </p>
    );
  }

  const nowIndex = milestones.findIndex((milestone) => milestone.status !== 'met');
  const topRisk = [...risks].sort((a, b) => weight(b.severity) - weight(a.severity))[0];

  return (
    <>
      <section aria-labelledby="tm-portal-milestones">
        <h2 id="tm-portal-milestones" className="tm-pt-visually-hidden">
          Milestones
        </h2>
        <ol className="tm-pt-track tm-pt-track--blocks">
          {milestones.map((milestone, index) => {
            const isNow = index === nowIndex;
            const done = milestone.status === 'met';
            const className = done
              ? 'tm-pt-step tm-pt-step--done'
              : isNow
                ? 'tm-pt-step tm-pt-step--now'
                : milestone.dueOn === null
                  ? 'tm-pt-step tm-pt-step--future'
                  : milestone.status === 'missed'
                    ? 'tm-pt-step tm-pt-step--late'
                    : 'tm-pt-step';
            return (
              <li
                key={milestone.id}
                className={className}
                {...(isNow ? { 'aria-current': 'step' as const } : {})}
              >
                <span className="tm-pt-step__date">
                  {isNow ? 'Now · ' : ''}
                  {milestone.dueOn === null
                    ? 'no date'
                    : `${isNow ? 'due ' : ''}${shortDay(milestone.dueOn)}`}
                </span>
                <span className="tm-pt-step__name">{milestone.title}</span>
                <span className="tm-pt-step__date tm-pt-step__date--after">
                  {statusLabel(milestone.status)}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="tm-pt-split tm-pt-split--aside tm-pt-split--wide">
        <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-portal-dates">
          <h2 id="tm-portal-dates" className="tm-pt-eyebrow">
            Every date, in order
          </h2>
          <ol className="tm-pt-rows">
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                <span className="tm-pt-mono tm-pt-rows__date">
                  {milestone.dueOn ? shortDay(milestone.dueOn) : 'No date'}
                </span>
                <div className="tm-pt-item__main">
                  <p className="tm-pt-rows__title">{milestone.title}</p>
                  <p className="tm-pt-quiet">{describeDue(milestone)}</p>
                </div>
                <Tag
                  tone={
                    milestone.status === 'met'
                      ? 'done'
                      : milestone.status === 'missed'
                        ? 'danger'
                        : undefined
                  }
                >
                  {statusLabel(milestone.status)}
                </Tag>
              </li>
            ))}
          </ol>
        </section>

        <section className="tm-pt-ink tm-pt-ink--tall" aria-labelledby="tm-portal-risk">
          <h2 id="tm-portal-risk" className="tm-pt-eyebrow">
            What would put the launch at risk
          </h2>
          <p className="tm-pt-ink__title">{topRisk ? topRisk.clientSummary : 'Nothing today.'}</p>
          <p className="tm-pt-quiet">
            {topRisk
              ? `${risks.length === 1 ? 'One open risk' : `${risks.length} open risks`} shared by ${providerName}. You would hear from them the same day if a date had to move.`
              : `${providerName} has not flagged anything that threatens a date. You would hear from them the same day if that changed.`}
          </p>
          <Link
            className="tm-pt-btn tm-pt-btn--lime tm-pt-ink__cta"
            href={`/${organizationSlug}/portal/risks`}
          >
            See every risk
          </Link>
        </section>
      </div>
    </>
  );
}

function weight(severity: ClientRisk['severity']): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

function statusLabel(status: MilestoneStatus): string {
  switch (status) {
    case 'met':
      return 'Done';
    case 'missed':
      return 'Missed';
    default:
      return 'Planned';
  }
}

function describeDue(milestone: ClientMilestone): string {
  if (milestone.dueOn === null) return 'No date committed yet';
  if (milestone.status === 'met') return `Done · was due ${longDay(milestone.dueOn)}`;
  if (milestone.status === 'missed') return `Missed · was due ${longDay(milestone.dueOn)}`;
  return `Committed for ${longDay(milestone.dueOn)}`;
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
