'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchWorkRelationsGraph } from '../../lib/api/work-relations-graph';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkRelationsGraphViewProps {
  organizationSlug: string;
  /** The work item at the centre of the graph. */
  workItemId: string;
  /** The item's title, for the panel heading and accessible labels. */
  workItemTitle: string;
  client?: ApiClient;
}

/** The depths the panel offers — the API bounds the walk to 1..3. */
const DEPTHS = [1, 2, 3] as const;

/** How each typed link reads in the adjacency table. */
const LINK_LABEL: Record<string, string> = {
  blocks: 'blocks',
  blocked_by: 'is blocked by',
  relates: 'relates to',
};

/**
 * **Work item relations graph (x274).**
 *
 * Module map §Work ("dependencies"): a read-only adjacency map of a work item's typed relations
 * (`blocks` / `blocked_by` / `relates`), walked to a chosen depth from the item. It reads
 * `GET …/work-items/:id/relations/graph?depth=` and writes nothing.
 *
 * As on the sibling read screens, **authorization is the API's**: a caller without `work.read`, or
 * for an item they cannot see, gets the ordinary refusal, which `describeError()` turns into a
 * sentence; the panel never guesses a capability of its own and never renders blank on a refusal.
 * An item the caller may not read is simply absent from the graph the API returns.
 */
export function WorkRelationsGraphView({
  organizationSlug,
  workItemId,
  workItemTitle,
  client,
}: WorkRelationsGraphViewProps) {
  const api = client ?? browserApiClient();
  const [depth, setDepth] = useState<number>(1);

  const headingId = `tm-relations-graph-${workItemId}`;

  const graph = useQuery({
    queryKey: ['work-relations-graph', organizationSlug, workItemId, depth],
    queryFn: () => fetchWorkRelationsGraph(api, organizationSlug, workItemId, { depth }),
  });

  const titleOf = (id: string): string =>
    graph.data?.nodes.find((node) => node.workItemId === id)?.title ?? id;

  const edges = graph.data?.edges ?? [];
  const nodeCount = graph.data?.nodes.length ?? 0;

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-eyebrow">
        Relations — {workItemTitle}
      </h3>

      <div className="tm-row" role="group" aria-label="Graph depth">
        {DEPTHS.map((value) => (
          <Button
            key={value}
            type="button"
            tone={value === depth ? 'ink' : 'outline'}
            size="accessible"
            aria-pressed={value === depth}
            onClick={() => setDepth(value)}
          >
            {`Depth ${value}`}
          </Button>
        ))}
      </div>

      {graph.isError ? (
        <InlineAlert tone="danger" title="Could not load the relations graph" live>
          {describeError(graph.error)}
        </InlineAlert>
      ) : null}

      {graph.isPending ? (
        <LoadingRegion label="Loading the work item's relations.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!graph.isPending && !graph.isError && edges.length === 0 ? (
        <InlineAlert tone="neutral" title="No relations yet">
          This work item has no typed links to other items within depth {depth}.
        </InlineAlert>
      ) : null}

      {edges.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`Relations of ${workItemTitle}`}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Typed links between the {nodeCount} items within depth {depth}, {edges.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">Relation</th>
                <th scope="col">To</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => (
                <tr key={`${edge.fromWorkItemId}|${edge.toWorkItemId}|${edge.linkType}`}>
                  <th scope="row" className="tm-table__title">
                    {titleOf(edge.fromWorkItemId)}
                  </th>
                  <td>{LINK_LABEL[edge.linkType] ?? edge.linkType}</td>
                  <td>{titleOf(edge.toWorkItemId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
