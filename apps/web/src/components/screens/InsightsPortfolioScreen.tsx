'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchInsightsPortfolio } from '../../lib/api/insights-portfolio';
import type { InsightsPortfolio, InsightsPortfolioProject } from '../../lib/api/insights-portfolio';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightsPortfolioScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Optional page-level actions rendered under the portfolio (e.g. the x135 CSV export). */
  children?: ReactNode;
}

/**
 * **Insights** — the portfolio overview, INS-01's org-level roll-up. It replaces the deferred
 * `/insights` stub with an index across the projects the caller can read: each project's headline
 * figures (its work total, what is blocked, and the approvals sent back for changes) and a drill-in
 * link to the per-project dashboard the per-project screens already build.
 *
 * It reads `GET /v1/organizations/:orgSlug/insights/portfolio`, gated on the server by `work.read`.
 * Three decisions, all from the sibling insights screens:
 *
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence; the screen never guesses a capability of its own.
 * 2. **No invented numbers.** A project the caller cannot read never appears (the server excludes
 *    it); an empty portfolio says so plainly rather than showing fabricated figures.
 * 3. **Editorial, three figures max.** Each row carries the exception evidence INS-01 lands on —
 *    total work, what is blocked, and approvals returned for changes — not the full roll-up, which
 *    lives on the per-project dashboard one click away.
 */
export function InsightsPortfolioScreen({
  organizationSlug,
  organizationName,
  client,
  children,
}: InsightsPortfolioScreenProps) {
  const api = client ?? browserApiClient();

  const portfolio = useQuery({
    queryKey: ['insights-portfolio', organizationSlug],
    queryFn: () => fetchInsightsPortfolio(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      title="Insights"
      description="How your projects are moving, and where the exceptions are."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-portfolio-heading">
        <h2 id="tm-portfolio-heading" className="tm-eyebrow">
          Portfolio
        </h2>

        {portfolio.isPending ? (
          <LoadingRegion label="Loading portfolio." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {portfolio.isError ? (
          <InlineAlert tone="danger" title="Could not load the portfolio" live>
            {describe(portfolio.error)}
          </InlineAlert>
        ) : null}

        {portfolio.isSuccess ? (
          <PortfolioTable portfolio={portfolio.data} organizationSlug={organizationSlug} />
        ) : null}
      </section>

      {children}
    </AppShell>
  );
}

function PortfolioTable({
  portfolio,
  organizationSlug,
}: {
  portfolio: InsightsPortfolio;
  organizationSlug: string;
}) {
  if (portfolio.projectCount === 0) {
    return <p className="tm-prose">No projects you can read have insights yet.</p>;
  }

  return (
    <>
      <table className="tm-table">
        <caption className="tm-visually-hidden">Projects by headline insight figures</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" className="tm-table__number">
              Work items
            </th>
            <th scope="col" className="tm-table__number">
              Blocked
            </th>
            <th scope="col" className="tm-table__number">
              Changes requested
            </th>
          </tr>
        </thead>
        <tbody>
          {portfolio.projects.map((project) => (
            <PortfolioRow
              key={project.projectId}
              project={project}
              organizationSlug={organizationSlug}
            />
          ))}
        </tbody>
      </table>

      <p className="tm-prose tm-mono">Computed {formatMoment(portfolio.computedAt)}.</p>
    </>
  );
}

function PortfolioRow({
  project,
  organizationSlug,
}: {
  project: InsightsPortfolioProject;
  organizationSlug: string;
}) {
  return (
    <tr>
      <th scope="row">
        <Link href={`/${organizationSlug}/insights/projects/${project.projectId}`}>
          {project.name}
        </Link>
      </th>
      <td className="tm-mono tm-table__number">{project.deliveryFlow.itemCount}</td>
      <td className="tm-mono tm-table__number">{project.deliveryFlow.counts.blocked}</td>
      <td className="tm-mono tm-table__number">
        {project.approvalCycle.metrics.changes_requested.count}
      </td>
    </tr>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
