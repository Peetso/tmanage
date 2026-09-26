'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjectPortfolio } from '../../lib/api/project-portfolio';
import type { ProjectPortfolioSummary } from '../../lib/api/project-portfolio';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectPortfolioScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Project portfolio (x137).**
 *
 * `38-MODULE-MAP` §Projects: a projects-owned roll-up across every project the reader can see — one
 * card per project with its open-work count, its objective tallies (x124), and when work last moved.
 * It reads `GET …/projects/portfolio`, gated on the server by `work.read`.
 *
 * ## Counts, not a score
 *
 * Like `ProjectOverviewScreen`, this screen shows arithmetic and no health grade: no RAG light, no
 * percentage, no ranking. A scored indicator needs a stated formula, and once a colour sits next to a
 * project name people manage the colour. Health scoring and a RAG model are deferred to NS-13.
 *
 * As everywhere, **authorization is the API's**: a caller without the capability gets the ordinary
 * refusal, which `describeError()` turns into a sentence; the screen never guesses a capability of its
 * own and never renders blank on a refusal.
 */
export function ProjectPortfolioScreen({
  organizationSlug,
  organizationName,
  client,
}: ProjectPortfolioScreenProps) {
  const api = client ?? browserApiClient();

  const portfolio = useQuery({
    queryKey: ['project-portfolio', organizationSlug],
    queryFn: () => listProjectPortfolio(api, organizationSlug),
  });

  const rows = portfolio.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Portfolio"
      description="Every project you can see, and where each one stands."
    >
      {portfolio.isError ? (
        <InlineAlert tone="danger" title="Could not load the portfolio" live>
          {describeError(portfolio.error)}
        </InlineAlert>
      ) : null}

      {portfolio.isPending ? (
        <LoadingRegion label="Loading the portfolio.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!portfolio.isPending && !portfolio.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No projects yet">
          There are no projects you can see. When one is created and shared with you, it appears here.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-stack" aria-labelledby="tm-portfolio-heading">
          <h2 id="tm-portfolio-heading" className="tm-eyebrow">
            Projects
          </h2>
          <ul className="tm-list">
            {rows.map((project) => (
              <li key={project.projectId}>
                <PortfolioCard organizationSlug={organizationSlug} project={project} />
              </li>
            ))}
          </ul>
          <p className="tm-field__hint">
            These are counts, not a score. Every one of them is a number you can check on the
            project.
          </p>
        </section>
      ) : null}
    </AppShell>
  );
}

function PortfolioCard({
  organizationSlug,
  project,
}: {
  organizationSlug: string;
  project: ProjectPortfolioSummary;
}) {
  const { open, met, missed } = project.objectiveCounts;
  const totalObjectives = open + met + missed;

  return (
    <article className="tm-panel tm-stack" aria-labelledby={`tm-portfolio-${project.projectId}`}>
      <div className="tm-row tm-row--wrap">
        <h3 id={`tm-portfolio-${project.projectId}`}>
          <Link href={`/${organizationSlug}/projects/${project.projectId}`}>{project.name}</Link>
        </h3>
        <StateCapsule state={project.status === 'active' ? 'current' : 'archived'}>
          {project.status === 'active' ? 'Active' : project.status}
        </StateCapsule>
      </div>

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Open work</dt>
          <dd>{project.openWorkCount}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Objectives</dt>
          <dd>
            {totalObjectives === 0
              ? 'None set'
              : `${open} open, ${met} met, ${missed} missed`}
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Last activity</dt>
          <dd>{project.latestActivityAt === null ? 'No activity yet' : formatInstant(project.latestActivityAt)}</dd>
        </div>
      </dl>
    </article>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
