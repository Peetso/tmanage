import Link from 'next/link';
import type { InsightsPortfolio, InsightsPortfolioProject } from '../../lib/api/insights-portfolio';

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
  if (portfolio.projectCount === 0) {
    return <p className="tm-prose">No projects you can read have insights yet.</p>;
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
      <dl className="tm-stack tm-stack--tight" aria-label="Portfolio headline figures">
        <Figure label="Projects" value={portfolio.projectCount} />
        <Figure label="Blocked work items" value={blocked} />
        <Figure label="Changes requested" value={changesRequested} />
      </dl>

      {needsAttention.length > 0 ? (
        <section className="tm-stack tm-stack--tight" aria-labelledby="tm-portfolio-attention">
          <h3 id="tm-portfolio-attention" className="tm-eyebrow">
            Needs attention
          </h3>
          <ul className="tm-list tm-stack tm-stack--tight">
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
        <p className="tm-prose">Nothing is blocked across your projects.</p>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="tm-prose">{label}</dt>
      <dd className="tm-mono">{value}</dd>
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
  return (
    <li>
      <Link href={`/${organizationSlug}/insights/projects/${project.projectId}`}>
        {project.name}
      </Link>
      <span className="tm-mono"> — {project.deliveryFlow.counts.blocked} blocked</span>
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
