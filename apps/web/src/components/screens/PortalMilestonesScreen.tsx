'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { useSelectedPortalProject } from '../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalMilestones, listPortalProjects, listPortalRisks } from '../../lib/api/portal';
import type { ClientMilestone, ClientRisk, MilestoneStatus } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { longDay, shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';

type Translate = ReturnType<typeof useT>;
type TranslateOr = ReturnType<typeof useTOr>;

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
  const t = useT();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const project = useSelectedPortalProject(projects.data);
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
      title={
        target
          ? `${t('PortalMilestonesScreen.reaches')} ${longDay(target)}`
          : t('PortalMilestonesScreen.timeline')
      }
      eyebrow={eyebrowFor(dated, t)}
      headerAside={ordered.length > 0 ? <Legend t={t} /> : undefined}
    >
      <div className="tm-pt tm-pt--compact">
        {projects.isError ? (
          <InlineAlert tone="danger" title={t('PortalMilestonesScreen.couldNotLoadPortal')} live>
            {describe(projects.error, t)}
          </InlineAlert>
        ) : null}

        {projects.isPending ? (
          <LoadingRegion label={t('PortalMilestonesScreen.loadingProject')}>
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
            t={t}
          />
        )}
      </div>
    </ClientPortalShell>
  );
}

function eyebrowFor(dated: readonly ClientMilestone[], t: Translate): string {
  if (dated.length === 0) return t('PortalMilestonesScreen.timeline');
  const month = (value: string | null) =>
    value ? new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date(value)) : '';
  const first = month(dated[0]!.dueOn);
  const last = month(dated[dated.length - 1]!.dueOn);
  return first === last
    ? `${t('PortalMilestonesScreen.timeline')} · ${first}`
    : `${t('PortalMilestonesScreen.timeline')} · ${first} ${t('PortalMilestonesScreen.rangeTo')} ${last}`;
}

function Legend({ t }: { t: Translate }) {
  const tOr = useTOr();
  return (
    <ul className="tm-pt-legend" aria-label={t('PortalMilestonesScreen.legendKey')}>
      <li>
        <span className="tm-pt-legend__dot tm-pt-legend__dot--done" aria-hidden="true" />
        {t('PortalMilestonesScreen.legendDone')}
      </li>
      <li>
        <span className="tm-pt-legend__dot tm-pt-legend__dot--now" aria-hidden="true" />
        {t('PortalMilestonesScreen.legendNow')}
      </li>
      <li>
        <span className="tm-pt-legend__dot" aria-hidden="true" />
        {tOr('PortalMilestonesScreen.legendAgreed', 'agreed date')}
      </li>
      <li>
        <span className="tm-pt-legend__dot tm-pt-legend__dot--none" aria-hidden="true" />
        {t('PortalMilestonesScreen.legendNoDate')}
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
  t: Translate;
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
  t,
}: MilestonesSectionProps) {
  const tOr = useTOr();
  if (!hasProject) {
    return (
      <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
        {t('PortalMilestonesScreen.noProjectLead')} {providerName}{' '}
        {t('PortalMilestonesScreen.noProjectTail')}
      </p>
    );
  }
  if (isError) {
    return (
      <InlineAlert tone="danger" title={t('PortalMilestonesScreen.couldNotLoadMilestones')} live>
        {describe(error, t)}
      </InlineAlert>
    );
  }
  if (isPending) {
    return (
      <LoadingRegion label={t('PortalMilestonesScreen.loadingMilestones')}>
        <Skeleton height="var(--row)" />
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (milestones.length === 0) {
    return (
      <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
        {providerName} {t('PortalMilestonesScreen.noMilestonesTail')}
      </p>
    );
  }

  const nowIndex = milestones.findIndex((milestone) => milestone.status !== 'met');
  const topRisk = [...risks].sort((a, b) => weight(b.severity) - weight(a.severity))[0];

  return (
    <>
      <section aria-labelledby="tm-portal-milestones">
        <h2 id="tm-portal-milestones" className="tm-pt-visually-hidden">
          {t('PortalMilestonesScreen.milestonesHeading')}
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
                  {isNow ? `${t('PortalMilestonesScreen.now')} · ` : ''}
                  {milestone.dueOn === null
                    ? t('PortalMilestonesScreen.noDateLower')
                    : `${isNow ? `${t('PortalMilestonesScreen.due')} ` : ''}${shortDay(milestone.dueOn)}`}
                </span>
                <span className="tm-pt-step__name">{milestone.title}</span>
                <span className="tm-pt-step__date tm-pt-step__date--after">
                  {statusLabel(milestone, t, tOr)}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="tm-pt-split tm-pt-split--aside tm-pt-split--wide">
        <section className="tm-pt-card tm-pt-card--lg" aria-labelledby="tm-portal-dates">
          <h2 id="tm-portal-dates" className="tm-pt-eyebrow">
            {t('PortalMilestonesScreen.everyDateInOrder')}
          </h2>
          <ol className="tm-pt-rows">
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                <span className="tm-pt-mono tm-pt-rows__date">
                  {milestone.dueOn ? shortDay(milestone.dueOn) : t('PortalMilestonesScreen.noDate')}
                </span>
                <div className="tm-pt-item__main">
                  <p className="tm-pt-rows__title">{milestone.title}</p>
                  <p className="tm-pt-quiet">{describeDue(milestone, t, tOr)}</p>
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
                  {statusLabel(milestone, t, tOr)}
                </Tag>
              </li>
            ))}
          </ol>
        </section>

        <section className="tm-pt-ink tm-pt-ink--tall" aria-labelledby="tm-portal-risk">
          <h2 id="tm-portal-risk" className="tm-pt-eyebrow">
            {t('PortalMilestonesScreen.launchRiskHeading')}
          </h2>
          <p className="tm-pt-ink__title">
            {topRisk ? topRisk.clientSummary : t('PortalMilestonesScreen.nothingToday')}
          </p>
          <p className="tm-pt-quiet">
            {topRisk
              ? `${risks.length === 1 ? t('PortalMilestonesScreen.oneOpenRisk') : `${risks.length} ${t('PortalMilestonesScreen.openRisksSuffix')}`} ${t('PortalMilestonesScreen.sharedBy')} ${providerName}. ${t('PortalMilestonesScreen.hearSameDayMove')}`
              : `${providerName} ${t('PortalMilestonesScreen.notFlaggedThreat')}`}
          </p>
          <Link
            className="tm-pt-btn tm-pt-btn--lime tm-pt-ink__cta"
            href={`/${organizationSlug}/portal/risks`}
          >
            {t('PortalMilestonesScreen.seeEveryRisk')}
          </Link>
        </section>
      </div>
    </>
  );
}

function weight(severity: ClientRisk['severity']): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

/**
 * B7 (2026-11-07): one vocabulary for dates — "agreed". An open stage with a date used to read
 * "Committed for …" beside a "Planned" tag, while the overview said no date was agreed; an open
 * stage now says whether its date is agreed, and an undated one says so plainly.
 */
export function statusLabel(
  milestone: Pick<ClientMilestone, 'status' | 'dueOn'>,
  t: Translate,
  tOr: TranslateOr,
): string {
  const status: MilestoneStatus = milestone.status;
  switch (status) {
    case 'met':
      return t('PortalMilestonesScreen.statusDone');
    case 'missed':
      return t('PortalMilestonesScreen.statusMissed');
    default:
      return milestone.dueOn === null
        ? tOr('PortalMilestonesScreen.statusNoDate', 'No date yet')
        : tOr('PortalMilestonesScreen.statusAgreed', 'Date agreed');
  }
}

function describeDue(milestone: ClientMilestone, t: Translate, tOr: TranslateOr): string {
  if (milestone.dueOn === null)
    return tOr('PortalMilestonesScreen.noDateAgreed', 'No date agreed yet');
  if (milestone.status === 'met')
    return `${t('PortalMilestonesScreen.doneWasDue')} ${longDay(milestone.dueOn)}`;
  if (milestone.status === 'missed')
    return `${t('PortalMilestonesScreen.missedWasDue')} ${longDay(milestone.dueOn)}`;
  return `${tOr('PortalMilestonesScreen.agreedFor', 'Agreed for')} ${longDay(milestone.dueOn)}`;
}

function byDueOn(left: ClientMilestone, right: ClientMilestone): number {
  if (left.dueOn === right.dueOn) return 0;
  if (left.dueOn === null) return 1;
  if (right.dueOn === null) return -1;
  return left.dueOn < right.dueOn ? -1 : 1;
}

function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PortalMilestonesScreen.portalNotAnswering');
  return t('PortalMilestonesScreen.genericError');
}
