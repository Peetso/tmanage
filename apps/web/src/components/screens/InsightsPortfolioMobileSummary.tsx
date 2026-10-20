'use client';

import Link from 'next/link';
import type { InsightsPortfolio, InsightsPortfolioProject } from '../../lib/api/insights-portfolio';
import { useT } from '../../lib/i18n/use-t';

/** How many projects the mobile "needs attention" list shows before it stops. */
const TOP_PROJECTS = 3;

export interface InsightsPortfolioMobileSummaryProps {
  portfolio: InsightsPortfolio;
  organizationSlug: string;
}

/**
 * The mobile companion for the Insights portfolio (Module 23 — "planning-heavy views transform to
 * summaries"). Below the shell's ~768px breakpoint the dense portfolio table is too wide to read, so
 * the screen renders this compact, read-only summary instead: the three portfolio-wide headline
 * figures, then the handful of projects carrying the most blocked work, each a drill-in link to its
 * full dashboard.
 *
 * It consumes the **same** {@link InsightsPortfolio} the full screen already fetched — no second
 * request, no new endpoint — and reads it, never mutating. The heavy grid is omitted entirely here,
 * not merely hidden with CSS, so a mobile reader is not handed an off-screen table. The full view is
 * one rotation or one wider viewport away; this is the exception digest, not a replacement.
 */
export function InsightsPortfolioMobileSummary({
  portfolio,
  organizationSlug,
}: InsightsPortfolioMobileSummaryProps) {
  const t = useT();
  if (portfolio.projectCount === 0) {
    return <p className="tm-ins-card__body">{t('InsightsPortfolioMobileSummary.emptyInsights')}</p>;
  }

  const blocked = sum(portfolio.projects, (project) => project.deliveryFlow.counts.blocked);
  const changesRequested = sum(
    portfolio.projects,
    (project) => project.approvalCycle.metrics.changes_requested.count,
  );
  const needsAttention = [...portfolio.projects]
    .filter((project) => project.deliveryFlow.counts.blocked > 0)
    .sort((a, b) => b.deliveryFlow.counts.blocked - a.deliveryFlow.counts.blocked)
    .slice(0, TOP_PROJECTS);

  return (
    <div className="tm-stack">
      <dl
        className="tm-ins-mfigures"
        aria-label={t('InsightsPortfolioMobileSummary.headlineFigures')}
      >
        <Figure
          label={t('InsightsPortfolioMobileSummary.figureProjects')}
          value={portfolio.projectCount}
        />
        <Figure label={t('InsightsPortfolioMobileSummary.figureBlocked')} value={blocked} />
        <Figure
          label={t('InsightsPortfolioMobileSummary.figureChanges')}
          value={changesRequested}
        />
      </dl>

      {needsAttention.length > 0 ? (
        <section className="tm-stack tm-stack--tight" aria-labelledby="tm-portfolio-attention">
          <h3 id="tm-portfolio-attention" className="tm-ins-eyebrow">
            {t('InsightsPortfolioMobileSummary.needsAttention')}
          </h3>
          <ul className="tm-ins-mlist">
            {needsAttention.map((project) => (
              <AttentionRow
                key={project.projectId}
                project={project}
                organizationSlug={organizationSlug}
              />
            ))}
          </ul>
        </section>
      ) : (
        <p className="tm-ins-card__body">{t('InsightsPortfolioMobileSummary.nothingBlocked')}</p>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="tm-ins-mfigure">
      <dt className="tm-ins-mfigure__label">{label}</dt>
      <dd className="tm-ins-mfigure__value">{value}</dd>
    </div>
  );
}

function AttentionRow({
  project,
  organizationSlug,
}: {
  project: InsightsPortfolioProject;
  organizationSlug: string;
}) {
  const t = useT();
  return (
    <li>
      <Link href={`/${organizationSlug}/insights/projects/${project.projectId}`}>
        {project.name}
      </Link>
      <span className="tm-ins-badge" data-tone="danger">
        {project.deliveryFlow.counts.blocked} {t('InsightsPortfolioMobileSummary.blocked')}
      </span>
    </li>
  );
}

/** Add up one field across the roll-up rows. */
function sum(
  projects: readonly InsightsPortfolioProject[],
  pick: (project: InsightsPortfolioProject) => number,
): number {
  return projects.reduce((total, project) => total + pick(project), 0);
}
