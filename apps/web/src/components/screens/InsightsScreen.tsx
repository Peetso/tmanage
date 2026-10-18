'use client';

import { useQuery } from '@tanstack/react-query';
import type { WorkItemState } from '@tmanage/domain';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import {
  InsightsCard,
  InsightsCardHead,
  InsightsMetric,
  InsightsMetrics,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchProjectDeliveryFlow } from '../../lib/api/delivery-flow';
import type { DeliveryFlow } from '../../lib/api/delivery-flow';
import { fetchProjectApprovalCycle } from '../../lib/api/approval-cycle';
import type {
  ApprovalCycle,
  ApprovalCycleOutcome,
  ApprovalOutcomeMetric,
} from '../../lib/api/approval-cycle';
import { fetchOrgWorkload } from '../../lib/api/insights-workload';
import { fetchInsightsPortfolio } from '../../lib/api/insights-portfolio';
import type { InsightsWorkloadView } from '../../lib/api/insights-workload';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightsScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Insights** — the project insights dashboard, INS's third slice. It is the read half of x89 and
 * x96 turned into a proven screen: it reads
 * `GET /v1/organizations/:orgSlug/insights/projects/:projectId/delivery-flow` (gated on the server
 * by `work.read`) and `…/approval-cycle` (gated on `approval.read`), and renders each as an
 * accessible read-only table — a project's work rolled up by workflow status, and its approvals
 * rolled up by terminal outcome with the decided ones' mean turnaround.
 *
 * Three decisions, all from the sibling insights/work screens:
 *
 * 1. **Authorization is the API's.** A caller without a read's capability gets the ordinary 403,
 *    which `describe()` turns into a sentence in that panel's own alert; the screen never guesses a
 *    capability of its own, never renders blank on a refusal, and each read is refused
 *    independently — a caller with `work.read` but not `approval.read` still sees the delivery flow.
 * 2. **No invented numbers.** An empty or unknown-to-this-tenant project shows every count at zero,
 *    plainly labelled. The reads are tenant-scoped in SQL and re-checked per row, so a cross-tenant
 *    project id returns an empty roll-up (no leak, no 500) rather than another tenant's figures.
 * 3. **No charts dependency.** Semantic tables with captions and row/column scope carry the data;
 *    a11y is checked against the mounted document, not asserted.
 */
export function InsightsScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: InsightsScreenProps) {
  const api = client ?? browserApiClient();

  const deliveryFlow = useQuery({
    queryKey: ['insights-delivery-flow', organizationSlug, projectId],
    queryFn: () => fetchProjectDeliveryFlow(api, organizationSlug, projectId),
  });

  const approvalCycle = useQuery({
    queryKey: ['insights-approval-cycle', organizationSlug, projectId],
    queryFn: () => fetchProjectApprovalCycle(api, organizationSlug, projectId),
  });

  // INS-05 — the org-wide workload roll-up. It does not depend on the project in the route: it is
  // the portfolio view across every project the caller may read, keyed on the org alone.
  const workload = useQuery({
    queryKey: ['insights-workload', organizationSlug],
    queryFn: () => fetchOrgWorkload(api, organizationSlug),
  });

  // Project names for the workload rows: the workload read carries ids only, the portfolio read
  // (same `work.read` gate, same cache key as INS-01) carries the names. Until it answers — or if
  // it is refused — a row falls back to its id rather than inventing a label.
  const portfolio = useQuery({
    queryKey: ['insights-portfolio', organizationSlug],
    queryFn: () => fetchInsightsPortfolio(api, organizationSlug),
    retry: false,
  });
  const projectNames = new Map(
    (portfolio.data?.projects ?? []).map((project) => [project.projectId, project.name]),
  );

  const flow = deliveryFlow.data;
  const cycle = approvalCycle.data;
  const open = flow ? OPEN_STATES.reduce((total, id) => total + flow.counts[id], 0) : 0;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow="Insights · Project health"
      title="Which promises are still true"
    >
      <div className="tm-ins">
        <InsightsTabs organizationSlug={organizationSlug} current="health" projectId={projectId} />

        {flow || cycle ? (
          <InsightsMetrics label="Project headline figures">
            {flow ? (
              <InsightsMetric
                value={flow.counts.blocked}
                badge={`of ${flow.itemCount}`}
                badgeTone={flow.counts.blocked > 0 ? 'danger' : 'quiet'}
                label="work items blocked in this project"
                note={flow.counts.blocked > 0 ? 'each one holds the plan' : 'nothing is blocked'}
              />
            ) : null}
            {cycle ? (
              <InsightsMetric
                value={cycle.metrics.changes_requested.count}
                badge={`of ${cycle.approvalCount}`}
                badgeTone={cycle.metrics.changes_requested.count > 0 ? 'warning' : 'quiet'}
                label="approvals sent back for changes"
                note={`${cycle.metrics.invalidated.count} invalidated by a new version`}
              />
            ) : null}
            {flow ? (
              <InsightsMetric
                value={open}
                badge={`${flow.counts.done} done`}
                badgeTone="lime"
                label="work items still open"
                note={`${flow.counts.internal_review} in internal review`}
              />
            ) : null}
          </InsightsMetrics>
        ) : null}

        <InsightsSplit
          main={
            <>
              <InsightsCard
                variant="table"
                id="tm-delivery-flow"
                labelledBy="tm-delivery-flow-heading"
              >
                <div className="tm-ins-card__lead tm-stack tm-stack--tight">
                  <InsightsCardHead
                    id="tm-delivery-flow-heading"
                    title="Delivery flow"
                    units="Pulse track · items by status"
                  />
                  {flow ? <PulseTrack flow={flow} /> : null}
                </div>

                {deliveryFlow.isPending ? (
                  <LoadingRegion label="Loading delivery flow." className="tm-ins-card__lead">
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}

                {deliveryFlow.isError ? (
                  <div className="tm-ins-card__lead">
                    <InlineAlert tone="danger" title="Could not load the delivery flow" live>
                      {describe(deliveryFlow.error)}
                    </InlineAlert>
                  </div>
                ) : null}

                {deliveryFlow.isSuccess ? <DeliveryFlowTable flow={deliveryFlow.data} /> : null}
              </InsightsCard>

              <InsightsCard variant="table" labelledBy="tm-approval-cycle-heading">
                <div className="tm-ins-card__lead">
                  <InsightsCardHead
                    id="tm-approval-cycle-heading"
                    title="Approval cycle"
                    units="Requested → decided"
                  />
                </div>

                {approvalCycle.isPending ? (
                  <LoadingRegion label="Loading approval cycle." className="tm-ins-card__lead">
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}

                {approvalCycle.isError ? (
                  <div className="tm-ins-card__lead">
                    <InlineAlert tone="danger" title="Could not load the approval cycle" live>
                      {describe(approvalCycle.error)}
                    </InlineAlert>
                  </div>
                ) : null}

                {approvalCycle.isSuccess ? <ApprovalCycleTable cycle={approvalCycle.data} /> : null}
              </InsightsCard>

              <InsightsCard variant="table" labelledBy="tm-workload-heading">
                <div className="tm-ins-card__lead">
                  <InsightsCardHead
                    id="tm-workload-heading"
                    title="Workload across projects"
                    units="Open · scheduled · people"
                  />
                </div>

                {workload.isPending ? (
                  <LoadingRegion label="Loading workload." className="tm-ins-card__lead">
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}

                {workload.isError ? (
                  <div className="tm-ins-card__lead">
                    <InlineAlert tone="danger" title="Could not load the workload roll-up" live>
                      {describe(workload.error)}
                    </InlineAlert>
                  </div>
                ) : null}

                {workload.isSuccess ? (
                  <WorkloadTable workload={workload.data} names={projectNames} />
                ) : null}
              </InsightsCard>
            </>
          }
          side={
            <>
              {flow ? (
                <InsightsCard variant="callout">
                  <p className="tm-ins-eyebrow">What would move this project</p>
                  <p className="tm-ins-callout__title">{nextMove(flow)}</p>
                  <p className="tm-ins-card__body">
                    Everything downstream of a blocked item moves with it. Clearing the blocker
                    moves the forecast; working faster around it does not.
                  </p>
                </InsightsCard>
              ) : null}
              <InsightsCard>
                <p className="tm-ins-eyebrow">How health is derived</p>
                <p className="tm-ins-card__body">
                  Health is the gap between the committed date and the current forecast, plus the
                  decisions blocking it. Nothing is inferred from message volume, activity or hours
                  logged.
                </p>
                <ul className="tm-ins-legend">
                  <li>
                    <span className="tm-ins-pulse__seg" data-state="done" aria-hidden="true" />
                    done
                  </li>
                  <li>
                    <span className="tm-ins-pulse__seg" data-state="current" aria-hidden="true" />
                    in progress or in review
                  </li>
                  <li>
                    <span className="tm-ins-pulse__seg" aria-hidden="true" />
                    still to do
                  </li>
                  <li>
                    <span className="tm-ins-pulse__seg" data-state="unknown" aria-hidden="true" />
                    nothing to show yet
                  </li>
                  <li>
                    <span className="tm-ins-pulse__edge" aria-hidden="true" />
                    risk edge: blocked work
                  </li>
                </ul>
              </InsightsCard>
            </>
          }
        />
      </div>
    </AppShell>
  );
}

/** The open (not done, not archived) statuses, summed for the "still open" figure. */
const OPEN_STATES: readonly WorkItemState[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
];

/** The callout's one sentence, read from the counts: blocked first, then review. */
function nextMove(flow: DeliveryFlow): string {
  const { blocked, internal_review: review } = flow.counts;
  if (blocked > 0)
    return `${blocked} blocked ${blocked === 1 ? 'item holds' : 'items hold'} the plan.`;
  if (review > 0)
    return `${review} ${review === 1 ? 'item waits' : 'items wait'} on internal review.`;
  return 'Nothing is blocked or waiting on review.';
}

/**
 * INS-02's pulse track for one project: a segment per lifecycle status sized by its items — done
 * is ink, in progress and review are lime, the rest is still to do — and the risk edge when
 * anything is blocked. Decorative: the status table under it carries the same figures.
 */
function PulseTrack({ flow }: { flow: DeliveryFlow }) {
  const segments: { id: WorkItemState; state?: 'done' | 'current' }[] = [
    { id: 'done', state: 'done' },
    { id: 'internal_review', state: 'current' },
    { id: 'in_progress', state: 'current' },
    { id: 'ready' },
    { id: 'backlog' },
  ];
  return (
    <div className="tm-ins-pulse" aria-hidden="true">
      {segments
        .filter(({ id }) => flow.counts[id] > 0)
        .map(({ id, state }) => (
          <span
            key={id}
            className="tm-ins-pulse__seg"
            style={{ flexGrow: flow.counts[id] }}
            {...(state ? { 'data-state': state } : {})}
          />
        ))}
      {flow.itemCount === 0 ? <span className="tm-ins-pulse__seg" data-state="unknown" /> : null}
      {flow.counts.blocked > 0 ? <span className="tm-ins-pulse__edge" /> : null}
    </div>
  );
}

/** The workflow statuses in the order they are shown — the lifecycle order the state machine defines. */
const STATUSES: readonly { id: WorkItemState; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'internal_review', label: 'Internal review' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
];

function DeliveryFlowTable({ flow }: { flow: DeliveryFlow }) {
  return (
    <>
      {flow.itemCount === 0 ? (
        <p className="tm-ins-card__body tm-ins-card__lead">
          No work items you can read in this project yet.
        </p>
      ) : null}

      <table className="tm-ins-table tm-ins-table--dense">
        <caption className="tm-visually-hidden">Work items by workflow status</caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col" className="tm-ins-table__num">
              Items
            </th>
          </tr>
        </thead>
        <tbody>
          {STATUSES.map(({ id, label }) => (
            <tr key={id}>
              <th scope="row">{label}</th>
              <td className="tm-ins-table__num">{flow.counts[id]}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="tm-ins-table__num">{flow.itemCount}</td>
          </tr>
        </tfoot>
      </table>

      <p className="tm-ins-card__foot">Computed {formatMoment(flow.computedAt)}.</p>
    </>
  );
}

/** The outcomes in the order they are shown — the same order the API rolls them up in. */
const OUTCOMES: readonly { id: ApprovalCycleOutcome; label: string }[] = [
  { id: 'approved', label: 'Approved' },
  { id: 'changes_requested', label: 'Changes requested' },
  { id: 'invalidated', label: 'Invalidated' },
];

function ApprovalCycleTable({ cycle }: { cycle: ApprovalCycle }) {
  return (
    <>
      {cycle.approvalCount === 0 ? (
        <p className="tm-ins-card__body tm-ins-card__lead">
          No approvals have reached a decision in this project yet.
        </p>
      ) : null}

      <table className="tm-ins-table tm-ins-table--dense">
        <caption className="tm-visually-hidden">Approvals by terminal outcome</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col" className="tm-ins-table__num">
              Approvals
            </th>
            <th scope="col" className="tm-ins-table__num">
              Decided
            </th>
            <th scope="col" className="tm-ins-table__num">
              Mean time to decide
            </th>
          </tr>
        </thead>
        <tbody>
          {OUTCOMES.map(({ id, label }) => (
            <tr key={id}>
              <th scope="row">{label}</th>
              <td className="tm-ins-table__num">{cycle.metrics[id].count}</td>
              <td className="tm-ins-table__num">{cycle.metrics[id].decidedCount}</td>
              <td className="tm-ins-table__num">{formatMeanDuration(cycle.metrics[id])}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="tm-ins-card__foot">Computed {formatMoment(cycle.computedAt)}.</p>
    </>
  );
}

/**
 * INS-05 — the org-wide workload roll-up. A per-project table (heaviest first, as the API orders
 * it) with the aggregate in the footer, and a drill-in link to each project's own delivery-flow
 * screen. No invented numbers: an empty portfolio (nothing the caller may read) is stated plainly.
 */
function WorkloadTable({
  workload,
  names,
}: {
  workload: InsightsWorkloadView;
  names: ReadonlyMap<string, string>;
}) {
  return (
    <>
      {workload.totals.projectCount === 0 ? (
        <p className="tm-ins-card__body tm-ins-card__lead">
          No projects you can read have open work yet.
        </p>
      ) : null}

      <table className="tm-ins-table tm-ins-table--dense">
        <caption className="tm-visually-hidden">Open work by project</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" className="tm-ins-table__num">
              Open items
            </th>
            <th scope="col" className="tm-ins-table__num">
              Scheduled
            </th>
            <th scope="col" className="tm-ins-table__num">
              People
            </th>
          </tr>
        </thead>
        <tbody>
          {workload.projects.map((project) => (
            <tr key={project.projectId}>
              <th scope="row">
                <a
                  className="tm-link"
                  href={`insights/projects/${encodeURIComponent(project.projectId)}`}
                >
                  {names.get(project.projectId) ?? project.projectId}
                </a>
              </th>
              <td className="tm-ins-table__num">{project.openItemCount}</td>
              <td className="tm-ins-table__num">{project.scheduledItemCount}</td>
              <td className="tm-ins-table__num">{project.assigneeCount}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All projects ({workload.totals.projectCount})</th>
            <td className="tm-ins-table__num">{workload.totals.openItemCount}</td>
            <td className="tm-ins-table__num">{workload.totals.scheduledItemCount}</td>
            <td className="tm-ins-table__num">{workload.totals.assigneeCount}</td>
          </tr>
        </tfoot>
      </table>

      <p className="tm-ins-card__foot">Computed {formatMoment(workload.computedAt)}.</p>
    </>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * The mean requested→decided time for an outcome, derived from the read's sum and count so no
 * rounding is baked into the API. An outcome with nothing decided (e.g. `invalidated`, which
 * records a reason but no decision time) has no mean and shows an em dash rather than `0`.
 */
function formatMeanDuration(metric: ApprovalOutcomeMetric): string {
  if (metric.decidedCount === 0) return '—';
  return formatDuration(metric.totalDurationMs / metric.decidedCount);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration in the units a person reads a review turnaround in: days over a day, hours over an
 * hour, minutes over a minute, seconds below that. One decimal place, and the whole-number case
 * loses its decimal (`3 d`, not `3.0 d`).
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= DAY) return `${trim(ms / DAY)} d`;
  if (ms >= HOUR) return `${trim(ms / HOUR)} h`;
  if (ms >= MINUTE) return `${trim(ms / MINUTE)} min`;
  return `${trim(ms / 1_000)} s`;
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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
