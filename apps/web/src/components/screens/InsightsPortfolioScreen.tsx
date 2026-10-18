'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { WorkItemState } from '@tmanage/domain';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { InsightsPortfolioMobileSummary } from './InsightsPortfolioMobileSummary';
import {
  InsightsBars,
  InsightsCard,
  InsightsCardHead,
  InsightsMetric,
  InsightsMetrics,
  InsightsNote,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import type { InsightsBar, InsightsTone } from './InsightsKit';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchInsightsPortfolio } from '../../lib/api/insights-portfolio';
import type { InsightsPortfolio, InsightsPortfolioProject } from '../../lib/api/insights-portfolio';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useIsMobile } from '../../lib/hooks/useIsMobile';

export interface InsightsPortfolioScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Header actions (INS-01's black "Export" capsule — the x135 workload CSV). */
  headerActions?: ReactNode;
  /** Optional page-level content rendered under the report. */
  children?: ReactNode;
}

/**
 * **Insights** — INS-01, the editorial exception report across the projects the caller can read.
 *
 * It reads `GET /v1/organizations/:orgSlug/insights/portfolio`, gated on the server by `work.read`.
 * Three decisions, all from the sibling insights screens:
 *
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence; the screen never guesses a capability of its own.
 * 2. **No invented numbers.** Every headline figure, row and bar is summed from the roll-up the API
 *    returned; a project the caller cannot read never appears, and an empty portfolio says so.
 * 3. **Exceptions, not averages.** Rows carry a risk edge (blocked work, approvals sent back) and
 *    there is no per-person figure anywhere — the frame's "no productivity scores" rule.
 */
export function InsightsPortfolioScreen({
  organizationSlug,
  organizationName,
  client,
  headerActions,
  children,
}: InsightsPortfolioScreenProps) {
  const api = client ?? browserApiClient();
  const isMobile = useIsMobile();

  const portfolio = useQuery({
    queryKey: ['insights-portfolio', organizationSlug],
    queryFn: () => fetchInsightsPortfolio(api, organizationSlug),
  });

  const projectCount = portfolio.data?.projectCount;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow="Insights · Client delivery"
      title="Where delivery is losing time"
      actions={
        <>
          {projectCount !== undefined ? (
            <span className="tm-ins-capsule">
              {projectCount} {projectCount === 1 ? 'project' : 'projects'}
            </span>
          ) : null}
          {headerActions}
        </>
      }
    >
      <div className="tm-ins">
        <InsightsTabs
          organizationSlug={organizationSlug}
          current="overview"
          {...(portfolio.data?.projects[0]
            ? { projectId: portfolio.data.projects[0].projectId }
            : {})}
        />

        {portfolio.isPending ? (
          <LoadingRegion label="Loading portfolio." className="tm-stack tm-stack--tight">
            <Skeleton height="72px" />
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
          isMobile ? (
            <InsightsCard>
              <InsightsPortfolioMobileSummary
                portfolio={portfolio.data}
                organizationSlug={organizationSlug}
              />
            </InsightsCard>
          ) : (
            <PortfolioReport portfolio={portfolio.data} organizationSlug={organizationSlug} />
          )
        ) : null}

        {children}
      </div>
    </AppShell>
  );
}

function PortfolioReport({
  portfolio,
  organizationSlug,
}: {
  portfolio: InsightsPortfolio;
  organizationSlug: string;
}) {
  if (portfolio.projectCount === 0) {
    return (
      <InsightsCard>
        <p className="tm-ins-card__body">No projects you can read have insights yet.</p>
      </InsightsCard>
    );
  }

  const { projects } = portfolio;
  const items = sum(projects, (p) => p.deliveryFlow.itemCount);
  const blocked = sum(projects, (p) => p.deliveryFlow.counts.blocked);
  const approvals = sum(projects, (p) => p.approvalCycle.approvalCount);
  const changes = sum(projects, (p) => p.approvalCycle.metrics.changes_requested.count);
  const decided = sum(
    projects,
    (p) =>
      p.approvalCycle.metrics.approved.decidedCount +
      p.approvalCycle.metrics.changes_requested.decidedCount,
  );
  const decidedMs = sum(
    projects,
    (p) =>
      p.approvalCycle.metrics.approved.totalDurationMs +
      p.approvalCycle.metrics.changes_requested.totalDurationMs,
  );
  const mostBlocked = [...projects].sort(
    (a, b) => b.deliveryFlow.counts.blocked - a.deliveryFlow.counts.blocked,
  )[0];

  return (
    <>
      <InsightsMetrics label="Portfolio headline figures">
        <InsightsMetric
          value={decided === 0 ? '—' : formatHours(decidedMs / decided)}
          label="mean wait for an approval decision"
          note={
            decided === 0
              ? 'no approval has been decided yet'
              : `${decided} ${decided === 1 ? 'approval' : 'approvals'} decided`
          }
        />
        <InsightsMetric
          value={blocked}
          badge={`of ${items}`}
          badgeTone={blocked > 0 ? 'danger' : 'quiet'}
          label="work items blocked right now"
          note={
            blocked > 0 && mostBlocked
              ? `${mostBlocked.deliveryFlow.counts.blocked} in ${mostBlocked.name}`
              : 'nothing is blocked'
          }
        />
        <InsightsMetric
          value={changes}
          {...(approvals > 0
            ? {
                badge: `of ${approvals}`,
                badgeTone: (changes > 0 ? 'warning' : 'lime') as InsightsTone,
              }
            : {})}
          label="approvals sent back for changes"
          note={`across ${portfolio.projectCount} ${portfolio.projectCount === 1 ? 'project' : 'projects'}`}
        />
      </InsightsMetrics>

      <InsightsSplit
        main={
          <>
            <div className="tm-ins-section-head">
              <h2 id="tm-portfolio-heading" className="tm-ins-section-head__title">
                Exceptions, not averages
              </h2>
              <span className="tm-ins-section-head__aside">
                every row opens the evidence that produced it
              </span>
            </div>
            <PortfolioTable portfolio={portfolio} organizationSlug={organizationSlug} />
          </>
        }
        side={
          <>
            <InsightsCard labelledBy="tm-portfolio-stages">
              <InsightsCardHead
                id="tm-portfolio-stages"
                title="Where the work sits"
                units="Items · all projects"
              />
              <StageBars projects={projects} />
            </InsightsCard>
            <InsightsNote eyebrow="What this report will not do">
              No per-person productivity score, no ranking of employees, no activity surveillance.
              Capacity is reported at team level with commitments, not output counts.
            </InsightsNote>
          </>
        }
      />
    </>
  );
}

function PortfolioTable({
  portfolio,
  organizationSlug,
}: {
  portfolio: InsightsPortfolio;
  organizationSlug: string;
}) {
  return (
    <InsightsCard variant="table" label="Portfolio">
      <table className="tm-ins-table">
        <caption className="tm-visually-hidden">Projects by headline insight figures</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" className="tm-ins-table__num">
              Work items
            </th>
            <th scope="col" className="tm-ins-table__num">
              Blocked
            </th>
            <th scope="col" className="tm-ins-table__num">
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
      <p className="tm-ins-card__foot">Computed {formatMoment(portfolio.computedAt)}.</p>
    </InsightsCard>
  );
}

function PortfolioRow({
  project,
  organizationSlug,
}: {
  project: InsightsPortfolioProject;
  organizationSlug: string;
}) {
  const blocked = project.deliveryFlow.counts.blocked;
  const changes = project.approvalCycle.metrics.changes_requested.count;
  const tone: InsightsTone = blocked > 0 ? 'danger' : changes > 0 ? 'warning' : 'quiet';
  return (
    <tr data-tone={tone}>
      <th scope="row">
        <Link href={`/${organizationSlug}/insights/projects/${project.projectId}`}>
          {project.name}
        </Link>
      </th>
      <td className="tm-ins-table__num">{project.deliveryFlow.itemCount}</td>
      <td className="tm-ins-table__num" {...(blocked > 0 ? { 'data-tone': 'danger' } : {})}>
        {blocked}
      </td>
      <td className="tm-ins-table__num" {...(changes > 0 ? { 'data-tone': 'warning' } : {})}>
        {changes}
      </td>
    </tr>
  );
}

const STAGES: readonly { id: WorkItemState; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'internal_review', label: 'Internal review' },
  { id: 'done', label: 'Done' },
];

/** INS-01's stage bars, summed across the roll-up. The open stage holding the most is lime. */
function StageBars({ projects }: { projects: readonly InsightsPortfolioProject[] }) {
  const totals = STAGES.map((stage) => ({
    ...stage,
    value: sum(projects, (p) => p.deliveryFlow.counts[stage.id]),
  }));
  const open = totals.filter((stage) => stage.id !== 'done');
  const heaviest = open.reduce<(typeof open)[number] | undefined>(
    (top, stage) => (stage.value > (top?.value ?? 0) ? stage : top),
    undefined,
  );
  const openTotal = sum(open, (stage) => stage.value);
  const bars: InsightsBar[] = totals.map((stage) => ({
    key: stage.id,
    label: stage.label,
    value: stage.value,
    tone: stage.id === heaviest?.id ? 'lime' : 'ink',
    emphasis: stage.id === heaviest?.id,
  }));

  return (
    <>
      <InsightsBars bars={bars} label="Work items by stage across projects" />
      <p className="tm-ins-card__body">
        {heaviest
          ? `${heaviest.label} holds the most open work: ${heaviest.value} of ${openTotal} open items.`
          : 'No open work across your projects.'}
      </p>
    </>
  );
}

/** Add up one field across rows. */
function sum<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/** A mean duration as the frame writes it: whole hours under three days, days above. */
function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 72) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
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
