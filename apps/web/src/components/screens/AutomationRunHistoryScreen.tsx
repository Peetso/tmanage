'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getWorkflowRun,
  listWorkflowRuns,
  type WorkflowRunStatus,
} from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AutomationRunHistoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The status filter options: "All" plus each allowlisted outcome the API accepts. */
const STATUS_OPTIONS = [
  { value: 'all', label: 'All runs' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value'];

/** Turn `notify_owner` into `Notify owner` for display. */
function humanize(kind: string): string {
  const spaced = kind.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A short, locale-stable rendering of an ISO instant. */
function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * **Automations & integrations (module 17, x164).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("run history"). This screen
 * reads the org-scoped, append-only record of every workflow run: a filterable list, newest first, and
 * a detail drawer that reads one run's `detail` on demand. Both routes are gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **Nothing runs here.** Runs are created by the execution path (x163); this screen only reads
 *   history. There is no re-run, edit or delete control — history is append-only.
 * - **The status filter offers only allowlisted values.** The `<select>` lists the exact set the API
 *   accepts, so a filter request is always a value the server will honour.
 */
export function AutomationRunHistoryScreen({
  organizationSlug,
  organizationName,
  client,
}: AutomationRunHistoryScreenProps) {
  const api = client ?? browserApiClient();

  const [status, setStatus] = useState<StatusFilter>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['workflow-runs', organizationSlug, status],
    queryFn: () =>
      listWorkflowRuns(
        api,
        organizationSlug,
        status === 'all' ? {} : { status: status as WorkflowRunStatus },
      ),
  });

  const detail = useQuery({
    queryKey: ['workflow-run-detail', organizationSlug, selectedRunId],
    queryFn: () => getWorkflowRun(api, organizationSlug, selectedRunId as string),
    enabled: selectedRunId !== null,
  });

  const rows = runs.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Automation runs"
      description="The history of every workflow run in this organization, newest first."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-run-filter-heading">
        <h2 id="tm-run-filter-heading" className="tm-eyebrow">
          Filter
        </h2>
        <Select
          label="Status"
          name="status"
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          hint="Show all runs, or only those with a given outcome."
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </section>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-run-list-heading">
        <h2 id="tm-run-list-heading" className="tm-eyebrow">
          Runs
        </h2>

        {runs.isError ? (
          <InlineAlert tone="danger" title="Could not load the run history" live>
            {describeError(runs.error)}
          </InlineAlert>
        ) : null}

        {runs.isPending ? (
          <LoadingRegion label="Loading the run history.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!runs.isPending && !runs.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No runs yet">
            When a workflow template runs, its outcome is recorded here.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Workflow runs"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Workflow runs for this organization, newest first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => (
                  <tr key={run.id}>
                    <th scope="row" className="tm-table__title">
                      {run.templateId}
                    </th>
                    <td>{humanize(run.status)}</td>
                    <td>{formatInstant(run.startedAt)}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        onClick={() => setSelectedRunId(run.id)}
                      >
                        View details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selectedRunId !== null ? (
        <aside
          className="tm-panel tm-stack"
          aria-labelledby="tm-run-detail-heading"
          aria-live="polite"
        >
          <div className="tm-row tm-row--between">
            <h2 id="tm-run-detail-heading" className="tm-eyebrow">
              Run detail
            </h2>
            <Button
              type="button"
              tone="text"
              size="accessible"
              onClick={() => setSelectedRunId(null)}
            >
              Close
            </Button>
          </div>

          {detail.isError ? (
            <InlineAlert tone="danger" title="Could not load the run" live>
              {describeError(detail.error)}
            </InlineAlert>
          ) : null}

          {detail.isPending ? (
            <LoadingRegion label="Loading the run detail.">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {detail.data ? (
            <dl className="tm-stack">
              <div>
                <dt className="tm-eyebrow">Template</dt>
                <dd>{detail.data.templateId}</dd>
              </div>
              <div>
                <dt className="tm-eyebrow">Status</dt>
                <dd>{humanize(detail.data.status)}</dd>
              </div>
              <div>
                <dt className="tm-eyebrow">Started</dt>
                <dd>{formatInstant(detail.data.startedAt)}</dd>
              </div>
              <div>
                <dt className="tm-eyebrow">Finished</dt>
                <dd>{formatInstant(detail.data.finishedAt)}</dd>
              </div>
              <div>
                <dt className="tm-eyebrow">Detail</dt>
                <dd>
                  <pre className="tm-code-block">{JSON.stringify(detail.data.detail, null, 2)}</pre>
                </dd>
              </div>
            </dl>
          ) : null}
        </aside>
      ) : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
