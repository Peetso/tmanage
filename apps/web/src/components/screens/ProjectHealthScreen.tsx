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
      eyebrow="Insights"
      title="Project health"
      description="Every project you can see, banded from its overdue milestones, open risks, and missed objectives."
    >
      <div className="tm-ins tm-ins-tool">
        {health.isError ? (
          <InlineAlert tone="danger" title="Could not load project health" live>
            {describeError(health.error)}
          </InlineAlert>
        ) : null}

        {health.isPending ? (
          <LoadingRegion label="Loading project health.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!health.isPending && !health.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No projects yet">
            There are no projects you can see. When one is created and shared with you, it appears
            here.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <section className="tm-stack" aria-labelledby="tm-health-heading">
            <h2 id="tm-health-heading" className="tm-eyebrow">
              Projects
            </h2>
            <ul className="tm-list">
              {rows.map((project) => (
                <li key={project.projectId}>
                  <HealthCard organizationSlug={organizationSlug} project={project} />
                </li>
              ))}
            </ul>
            <p className="tm-field__hint">
              Each band is computed from fixed weights on the server, so two people see the same
              project in the same colour. The signals below are the ones it came from.
            </p>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

const BAND_LABEL: Record<ProjectHealthBand, string> = {
  green: 'On track',
  amber: 'Needs attention',
  red: 'At risk',
  neutral: 'Not yet assessed',
};

function HealthCard({
  organizationSlug,
  project,
}: {
  organizationSlug: string;
  project: ProjectHealthSummary;
}) {
  const { signals } = project;

  return (
    <article className="tm-panel tm-stack" aria-labelledby={`tm-health-${project.projectId}`}>
      <div className="tm-row tm-row--wrap">
        <h3 id={`tm-health-${project.projectId}`}>
          <Link href={`/${organizationSlug}/projects/${project.projectId}`}>{project.name}</Link>
        </h3>
        <StateCapsule state={bandState(project.band)}>{BAND_LABEL[project.band]}</StateCapsule>
      </div>

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Score</dt>
          <dd>{project.band === 'neutral' ? 'Not yet assessed' : `${project.score} / 100`}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Overdue milestones</dt>
          <dd>{signals.overdueMilestones}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Open risks</dt>
          <dd>
            {signals.openRisks === 0 ? 'None' : `${signals.openRisks} (${signals.highRisks} high)`}
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Objectives</dt>
          <dd>
            {signals.objectivesTotal === 0
              ? 'None set'
              : `${signals.objectivesMissed} missed of ${signals.objectivesTotal}`}
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
