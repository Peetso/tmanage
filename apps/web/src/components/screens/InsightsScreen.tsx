'use client';

import { useQuery } from '@tanstack/react-query';
import type { WorkItemState } from '@tmanage/domain';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchProjectDeliveryFlow } from '../../lib/api/delivery-flow';
import type { DeliveryFlow } from '../../lib/api/delivery-flow';
import { fetchProjectApprovalCycle } from '../../lib/api/approval-cycle';
import type {
  ApprovalCycle,
  ApprovalCycleOutcome,
  ApprovalOutcomeMetric,
} from '../../lib/api/approval-cycle';
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      title="Insights"
      description="How this project's work is moving and how its approvals were decided."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-delivery-flow-heading">
        <h2 id="tm-delivery-flow-heading" className="tm-eyebrow">
          Delivery flow
        </h2>

        {deliveryFlow.isPending ? (
          <LoadingRegion label="Loading delivery flow." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {deliveryFlow.isError ? (
          <InlineAlert tone="danger" title="Could not load the delivery flow" live>
            {describe(deliveryFlow.error)}
          </InlineAlert>
        ) : null}

        {deliveryFlow.isSuccess ? <DeliveryFlowTable flow={deliveryFlow.data} /> : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-approval-cycle-heading">
        <h2 id="tm-approval-cycle-heading" className="tm-eyebrow">
          Approval cycle
        </h2>

        {approvalCycle.isPending ? (
          <LoadingRegion label="Loading approval cycle." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {approvalCycle.isError ? (
          <InlineAlert tone="danger" title="Could not load the approval cycle" live>
            {describe(approvalCycle.error)}
          </InlineAlert>
        ) : null}

        {approvalCycle.isSuccess ? <ApprovalCycleTable cycle={approvalCycle.data} /> : null}
      </section>
    </AppShell>
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
        <p className="tm-prose">No work items you can read in this project yet.</p>
      ) : null}

      <table className="tm-table">
        <caption className="tm-visually-hidden">Work items by workflow status</caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col" className="tm-table__number">
              Items
            </th>
          </tr>
        </thead>
        <tbody>
          {STATUSES.map(({ id, label }) => (
            <tr key={id}>
              <th scope="row">{label}</th>
              <td className="tm-mono tm-table__number">{flow.counts[id]}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="tm-mono tm-table__number">{flow.itemCount}</td>
          </tr>
        </tfoot>
      </table>

      <p className="tm-prose tm-mono">Computed {formatMoment(flow.computedAt)}.</p>
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
        <p className="tm-prose">No approvals have reached a decision in this project yet.</p>
      ) : null}

      <table className="tm-table">
        <caption className="tm-visually-hidden">Approvals by terminal outcome</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col" className="tm-table__number">
              Approvals
            </th>
            <th scope="col" className="tm-table__number">
              Decided
            </th>
            <th scope="col" className="tm-table__number">
              Mean time to decide
            </th>
          </tr>
        </thead>
        <tbody>
          {OUTCOMES.map(({ id, label }) => (
            <tr key={id}>
              <th scope="row">{label}</th>
              <td className="tm-mono tm-table__number">{cycle.metrics[id].count}</td>
              <td className="tm-mono tm-table__number">{cycle.metrics[id].decidedCount}</td>
              <td className="tm-mono tm-table__number">{formatMeanDuration(cycle.metrics[id])}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="tm-prose tm-mono">Computed {formatMoment(cycle.computedAt)}.</p>
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
