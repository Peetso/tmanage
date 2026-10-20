'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/insights.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjectHealth } from '../../lib/api/project-health';
import type { ProjectHealthBand, ProjectHealthSummary } from '../../lib/api/project-health';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

type Translate = ReturnType<typeof useT>;

export interface ProjectHealthScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Project health (x208).**
 *
 * `38-MODULE-MAP` §Projects: the projects-owned health roll-up. One card per project the reader can
 * see, each banded green / amber / red from its overdue milestones (x139), open risks (x140) and
 * missed objectives (x124). It reads `GET …/projects/health`, gated on the server by `work.read`.
 *
 * ## The band is the server's, and it is explained
 *
 * Unlike `ProjectPortfolioScreen` (x137), which shows counts and refuses a score, this screen does
 * band each project — but the score and thresholds are computed on the server from fixed weights, so
 * the colour is reproducible and the screen never invents one. Each card shows the signals the band
 * came from, so the colour is never a black box. A project with no signals is shown as **not yet
 * assessed** rather than a green all-clear.
 *
 * As everywhere, **authorization is the API's**: a caller without the capability gets the ordinary
 * refusal, which `describeError()` turns into a sentence; the screen never guesses a capability of its
 * own and never renders blank on a refusal.
 */
export function ProjectHealthScreen({
  organizationSlug,
  organizationName,
  client,
}: ProjectHealthScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const health = useQuery({
    queryKey: ['project-health', organizationSlug],
    queryFn: () => listProjectHealth(api, organizationSlug),
  });

  const rows = health.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('ProjectHealthScreen.eyebrow')}
      title={t('ProjectHealthScreen.title')}
      description={t('ProjectHealthScreen.description')}
    >
      <div className="tm-ins tm-ins-tool">
        {health.isError ? (
          <InlineAlert tone="danger" title={t('ProjectHealthScreen.couldNotLoad')} live>
            {describeError(health.error, t)}
          </InlineAlert>
        ) : null}

        {health.isPending ? (
          <LoadingRegion label={t('ProjectHealthScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!health.isPending && !health.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title={t('ProjectHealthScreen.noProjectsTitle')}>
            {t('ProjectHealthScreen.noProjectsBody')}
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <section className="tm-stack" aria-labelledby="tm-health-heading">
            <h2 id="tm-health-heading" className="tm-eyebrow">
              {t('ProjectHealthScreen.projectsHeading')}
            </h2>
            <ul className="tm-list">
              {rows.map((project) => (
                <li key={project.projectId}>
                  <HealthCard organizationSlug={organizationSlug} project={project} t={t} />
                </li>
              ))}
            </ul>
            <p className="tm-field__hint">{t('ProjectHealthScreen.bandExplain')}</p>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

const BAND_LABEL: Record<ProjectHealthBand, MessageKey> = {
  green: 'ProjectHealthScreen.bandGreen',
  amber: 'ProjectHealthScreen.bandAmber',
  red: 'ProjectHealthScreen.bandRed',
  neutral: 'ProjectHealthScreen.bandNeutral',
};

function HealthCard({
  organizationSlug,
  project,
  t,
}: {
  organizationSlug: string;
  project: ProjectHealthSummary;
  t: Translate;
}) {
  const { signals } = project;

  return (
    <article className="tm-panel tm-stack" aria-labelledby={`tm-health-${project.projectId}`}>
      <div className="tm-row tm-row--wrap">
        <h3 id={`tm-health-${project.projectId}`}>
          <Link href={`/${organizationSlug}/projects/${project.projectId}`}>{project.name}</Link>
        </h3>
        <StateCapsule state={bandState(project.band)}>{t(BAND_LABEL[project.band])}</StateCapsule>
      </div>

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>{t('ProjectHealthScreen.score')}</dt>
          <dd>
            {project.band === 'neutral'
              ? t('ProjectHealthScreen.bandNeutral')
              : `${project.score} / 100`}
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>{t('ProjectHealthScreen.overdueMilestones')}</dt>
          <dd>{signals.overdueMilestones}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>{t('ProjectHealthScreen.openRisks')}</dt>
          <dd>
            {signals.openRisks === 0
              ? t('ProjectHealthScreen.none')
              : `${signals.openRisks} (${signals.highRisks} ${t('ProjectHealthScreen.high')})`}
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>{t('ProjectHealthScreen.objectives')}</dt>
          <dd>
            {signals.objectivesTotal === 0
              ? t('ProjectHealthScreen.noneSet')
              : `${signals.objectivesMissed} ${t('ProjectHealthScreen.missedOf')} ${signals.objectivesTotal}`}
          </dd>
        </div>
      </dl>
    </article>
  );
}

/** Map a health band onto the closest `StateCapsule` tone. */
function bandState(band: ProjectHealthBand): 'current' | 'waiting' | 'blocked' | 'neutral' {
  switch (band) {
    case 'green':
      return 'current';
    case 'amber':
      return 'waiting';
    case 'red':
      return 'blocked';
    default:
      return 'neutral';
  }
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectHealthScreen.apiError');
  return t('ProjectHealthScreen.genericError');
}
