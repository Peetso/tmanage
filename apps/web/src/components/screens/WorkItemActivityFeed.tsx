'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listWorkActivity, type WorkActivityEntry } from '../../lib/api/work-activity';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkItemActivityFeedProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString();
}

/** A small glyph per entry kind — a spoken label goes on the row, this is decoration only. */
function icon(kind: WorkActivityEntry['kind']): string {
  return kind === 'comment' ? '💬' : '●';
}

/**
 * **Work item activity timeline (module 7, x291).**
 *
 * `38-MODULE-MAP` §Work — the audit's "Work built; no unified item history". One read-only,
 * chronological feed of what already happened to the item — status changes and other audited
 * moves merged with member comments — newest first, drawn entirely from rows other slices write.
 * Behind `work.read`: anyone who may read the item may read its history, and the API answers 404
 * for an item in another tenant exactly as for one that does not exist. There is no write here;
 * the comment box and the status controls live on their own screens.
 */
export function WorkItemActivityFeed({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemActivityFeedProps) {
  const api = client ?? browserApiClient();

  const activity = useQuery({
    queryKey: ['work-item-activity', organizationSlug, workItemId],
    queryFn: () => listWorkActivity(api, organizationSlug, workItemId),
  });

  const entries: readonly WorkActivityEntry[] = activity.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Activity"
      description="The item’s history — status changes and comments — newest first."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-work-activity">
        <h2 id="tm-work-activity" className="tm-eyebrow">
          Activity
        </h2>

        {activity.isPending ? (
          <LoadingRegion label="Loading this item’s activity.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {activity.isError ? (
          <InlineAlert tone="danger" title="Could not load the activity" live>
            {describe(activity.error)}
          </InlineAlert>
        ) : null}

        {activity.data ? (
          entries.length === 0 ? (
            <p className="tm-prose">Nothing has happened on this item yet.</p>
          ) : (
            <ol className="tm-list" aria-label="Activity timeline">
              {entries.map((entry) => (
                <li key={`${entry.kind}:${entry.id}`} className="tm-stack">
                  <p className="tm-prose">
                    <span aria-hidden="true">{icon(entry.kind)}</span>{' '}
                    {entry.actorId ? `${entry.actorId} — ` : 'System — '}
                    {entry.summary}
                  </p>
                  <time className="tm-eyebrow" dateTime={entry.occurredAt}>
                    {formatWhen(entry.occurredAt)}
                  </time>
                </li>
              ))}
            </ol>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
