'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchWorkRelationsGraph } from '../../lib/api/work-relations-graph';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

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
  const describeError = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();
  const [depth, setDepth] = useState<number>(1);

  /** How each typed link reads in the adjacency table. */
  const linkLabel: Record<string, string> = {
    blocks: t('WorkRelationsGraphView.linkBlocks'),
    blocked_by: t('WorkRelationsGraphView.linkBlockedBy'),
    relates: t('WorkRelationsGraphView.linkRelates'),
  };

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
        {t('WorkRelationsGraphView.relationsPrefix')} {workItemTitle}
      </h3>

      <div className="tm-row" role="group" aria-label={t('WorkRelationsGraphView.graphDepth')}>
        {DEPTHS.map((value) => (
          <Button
            key={value}
            type="button"
            tone={value === depth ? 'ink' : 'outline'}
            size="accessible"
            aria-pressed={value === depth}
            onClick={() => setDepth(value)}
          >
            {`${t('WorkRelationsGraphView.depthPrefix')} ${value}`}
          </Button>
        ))}
      </div>

      {graph.isError ? (
        <InlineAlert tone="danger" title={t('WorkRelationsGraphView.loadError')} live>
          {describeError(graph.error)}
        </InlineAlert>
      ) : null}

      {graph.isPending ? (
        <LoadingRegion label={t('WorkRelationsGraphView.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!graph.isPending && !graph.isError && edges.length === 0 ? (
        <InlineAlert tone="neutral" title={t('WorkRelationsGraphView.noRelationsTitle')}>
          {t('WorkRelationsGraphView.noRelationsBody')} {depth}.
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
          aria-label={`${t('WorkRelationsGraphView.relationsOf')} ${workItemTitle}`}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              {t('WorkRelationsGraphView.captionPre')} {nodeCount}{' '}
              {t('WorkRelationsGraphView.captionItemsWithinDepth')} {depth}, {edges.length}{' '}
              {t('WorkRelationsGraphView.captionShown')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('WorkRelationsGraphView.colFrom')}</th>
                <th scope="col">{t('WorkRelationsGraphView.colRelation')}</th>
                <th scope="col">{t('WorkRelationsGraphView.colTo')}</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge) => (
                <tr key={`${edge.fromWorkItemId}|${edge.toWorkItemId}|${edge.linkType}`}>
                  <th scope="row" className="tm-table__title">
                    {titleOf(edge.fromWorkItemId)}
                  </th>
                  <td>{linkLabel[edge.linkType] ?? edge.linkType}</td>
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
