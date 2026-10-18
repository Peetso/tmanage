'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import {
  InsightsBars,
  InsightsCard,
  InsightsCardHead,
  InsightsNote,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import type { InsightsBar } from './InsightsKit';
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
      eyebrow={
        cycle.data
          ? `Insights · Approval flow · ${cycle.data.approvalCount} ${cycle.data.approvalCount === 1 ? 'request' : 'requests'}`
          : 'Insights · Approval flow'
      }
      title="What happens after we ask"
    >
      <div className="tm-ins">
        <InsightsTabs
          organizationSlug={organizationSlug}
          current="approvals"
          projectId={projectId}
        />

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
      </div>
    </AppShell>
  );
}

/** The outcomes in the order they are shown — the same order the API rolls them up in. */
const OUTCOMES: readonly { id: ApprovalCycleOutcome; label: string; tone: InsightsBar['tone'] }[] =
  [
    { id: 'approved', label: 'Approved', tone: 'success' },
    { id: 'changes_requested', label: 'Changes requested', tone: 'warning' },
    { id: 'invalidated', label: 'Invalidated', tone: 'danger' },
  ];

function ApprovalCyclePanel({ cycle }: { cycle: ApprovalCycle }) {
  const { approved, changes_requested: changes, invalidated } = cycle.metrics;
  const decided = approved.decidedCount + changes.decidedCount;
  const decidedMs = approved.totalDurationMs + changes.totalDurationMs;
  const mean = decided === 0 ? '—' : formatDuration(decidedMs / decided);

  return (
    <>
      <div className="tm-ins-split">
        <div className="tm-ins-split__main">
          <InsightsCard labelledBy="tm-approval-funnel-heading">
            <InsightsCardHead
              id="tm-approval-funnel-heading"
              title="Requested, decided, invalidated"
              units={`${cycle.approvalCount} requests · mean time to decide`}
            />
            <ol className="tm-ins-funnel">
              <li className="tm-ins-funnel__step" style={{ flex: 1.3 }}>
                <span className="tm-ins-funnel__pill">{cycle.approvalCount} requested</span>
                <span className="tm-ins-funnel__meta">–</span>
              </li>
              <li className="tm-ins-funnel__step" data-tone="lime" style={{ flex: 1.1 }}>
                <span className="tm-ins-funnel__pill">{decided} decided</span>
                <span className="tm-ins-funnel__meta">{mean} mean</span>
              </li>
              <li className="tm-ins-funnel__step" data-tone="quiet" style={{ flex: 1 }}>
                <span className="tm-ins-funnel__pill">{invalidated.count} invalidated</span>
                <span className="tm-ins-funnel__meta">new version</span>
              </li>
            </ol>
            <p className="tm-ins-card__body">
              {cycle.approvalCount === 0
                ? 'No approvals have reached a decision in this project yet.'
                : `${decided} of ${cycle.approvalCount} approval requests reached a decision. The rest are still with the reviewer or were replaced by a new version.`}
            </p>
          </InsightsCard>
        </div>
        <div className="tm-ins-split__side">
          <InsightsCard labelledBy="tm-approval-outcomes-heading">
            <p id="tm-approval-outcomes-heading" className="tm-ins-eyebrow">
              Outcomes of the {cycle.approvalCount} requested
            </p>
            <InsightsBars
              label="Approvals by outcome"
              bars={OUTCOMES.map(({ id, label, tone }) => ({
                key: id,
                label,
                value: cycle.metrics[id].count,
                ...(tone ? { tone } : {}),
              }))}
            />
            <div className="tm-ins-metric__figure">
              <span className="tm-ins-metric__value tm-ins-metric__value--sm">
                {invalidated.count}
              </span>
              <span className="tm-ins-card__body">
                approvals invalidated by a new version after review started
              </span>
            </div>
          </InsightsCard>
        </div>
      </div>

      <InsightsSplit
        main={
          <InsightsCard variant="table" labelledBy="tm-approval-cycle-heading">
            <div className="tm-ins-card__lead">
              <InsightsCardHead
                id="tm-approval-cycle-heading"
                title="This project"
                units="Approvals · decided · mean"
              />
            </div>
            <table
              className="tm-ins-table tm-ins-table--dense"
              aria-labelledby="tm-approval-cycle-heading"
            >
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
                  <OutcomeRow key={id} id={id} label={label} metric={cycle.metrics[id]} />
                ))}
              </tbody>
            </table>
            <p className="tm-ins-card__foot">Computed {formatMoment(cycle.computedAt)}.</p>
          </InsightsCard>
        }
        side={
          <>
            <InsightsCard variant="callout">
              <p className="tm-ins-eyebrow">The pattern worth acting on</p>
              <p className="tm-ins-callout__title">{pattern(cycle)}</p>
              <p className="tm-ins-card__body">
                A request sent to someone who cannot approve it waits without moving. Naming the
                person with the authority shortens the wait more than a reminder does.
              </p>
            </InsightsCard>
            <InsightsNote eyebrow="What this is not">
              Reviewer times describe the request path, not the person. Client response times are
              never shown inside the client portal.
            </InsightsNote>
          </>
        }
      />
    </>
  );
}

/** The callout's sentence, read from the outcome counts. */
function pattern(cycle: ApprovalCycle): string {
  const { approved, changes_requested: changes, invalidated } = cycle.metrics;
  if (cycle.approvalCount === 0) return 'Nothing has been asked yet, so there is no pattern.';
  if (invalidated.count > 0 && invalidated.count >= changes.count) {
    return `${invalidated.count} of ${cycle.approvalCount} approvals were invalidated by a new version after review started.`;
  }
  if (changes.count > approved.count) {
    return 'More requests come back for changes than pass first time.';
  }
  return `${approved.count} of ${cycle.approvalCount} requests were approved; ${changes.count} came back for changes.`;
}

function OutcomeRow({
  id,
  label,
  metric,
}: {
  id: ApprovalCycleOutcome;
  label: string;
  metric: ApprovalOutcomeMetric;
}) {
  const tone =
    metric.count === 0
      ? 'quiet'
      : id === 'approved'
        ? 'lime'
        : id === 'invalidated'
          ? 'danger'
          : 'warning';
  return (
    <tr data-tone={tone}>
      <th scope="row">{label}</th>
      <td className="tm-ins-table__num">{metric.count}</td>
      <td className="tm-ins-table__num">{metric.decidedCount}</td>
      <td className="tm-ins-table__num">{formatMeanDuration(metric)}</td>
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
