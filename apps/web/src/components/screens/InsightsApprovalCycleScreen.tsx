'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchProjectApprovalCycle } from '../../lib/api/approval-cycle';
import type {
  ApprovalCycle,
  ApprovalCycleOutcome,
  ApprovalOutcomeMetric,
} from '../../lib/api/approval-cycle';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface InsightsApprovalCycleScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Approval cycle** — the insights read INS-02 ships, the counterpart to INS-01's delivery flow.
 * It reads `GET /v1/organizations/:orgSlug/insights/projects/:projectId/approval-cycle`, gated on
 * the server by `approval.read`, and shows a project's approvals rolled up by terminal outcome
 * with the decided ones' mean requested→decided time.
 *
 * Two decisions worth stating, both from the sibling insights/work screens:
 *
 * 1. **Authorization is the API's.** A caller without `approval.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence; the screen never guesses a capability of its own and
 *    never renders blank on a refusal.
 * 2. **No invented numbers.** An empty project shows every outcome at zero, plainly labelled — the
 *    same posture the planned-insights placeholder took, now with a real read behind it.
 */
export function InsightsApprovalCycleScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: InsightsApprovalCycleScreenProps) {
  const api = client ?? browserApiClient();

  const cycle = useQuery({
    queryKey: ['insights-approval-cycle', organizationSlug, projectId],
    queryFn: () => fetchProjectApprovalCycle(api, organizationSlug, projectId),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      title="Approval cycle"
      description="How this project's approvals were decided, and how long they took."
    >
      {cycle.isPending ? (
        <LoadingRegion label="Loading approval cycle." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {cycle.isError ? (
        <InlineAlert tone="danger" title="Could not load the approval cycle" live>
          {describe(cycle.error)}
        </InlineAlert>
      ) : null}

      {cycle.isSuccess ? <ApprovalCyclePanel cycle={cycle.data} /> : null}
    </AppShell>
  );
}

/** The outcomes in the order they are shown — the same order the API rolls them up in. */
const OUTCOMES: readonly { id: ApprovalCycleOutcome; label: string }[] = [
  { id: 'approved', label: 'Approved' },
  { id: 'changes_requested', label: 'Changes requested' },
  { id: 'invalidated', label: 'Invalidated' },
];

function ApprovalCyclePanel({ cycle }: { cycle: ApprovalCycle }) {
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-approval-cycle-heading">
      <h2 id="tm-approval-cycle-heading" className="tm-eyebrow">
        This project
      </h2>

      {cycle.approvalCount === 0 ? (
        <p className="tm-prose">No approvals have reached a decision in this project yet.</p>
      ) : null}

      <table className="tm-table" aria-labelledby="tm-approval-cycle-heading">
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
            <OutcomeRow key={id} label={label} metric={cycle.metrics[id]} />
          ))}
        </tbody>
      </table>

      <p className="tm-prose tm-mono">Computed {formatMoment(cycle.computedAt)}.</p>
    </section>
  );
}

function OutcomeRow({ label, metric }: { label: string; metric: ApprovalOutcomeMetric }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="tm-mono tm-table__number">{metric.count}</td>
      <td className="tm-mono tm-table__number">{metric.decidedCount}</td>
      <td className="tm-mono tm-table__number">{formatMeanDuration(metric)}</td>
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
