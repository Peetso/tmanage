'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listWebhookDeliveries, type WebhookDeliveryView } from '../../lib/api/webhook-deliveries';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WebhookDeliveryScreenProps {
  organizationSlug: string;
  organizationName: string;
  endpointId: string;
  client?: ApiClient;
}

/**
 * **Automations webhook delivery log (module 17, x221).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("webhooks"); audit rank
 * #2. The read/history surface for one webhook endpoint: its recorded delivery attempts, newest
 * first, each with a status badge, the HTTP response code (when one was received), and when it was
 * attempted. Gated on `org.manage` by the API, so a caller without the capability sees the API's
 * refusal rather than a blank page.
 *
 * A delivery record carries only the outcome — never the endpoint's signing secret or any request /
 * response body — so none of those are shown. Dispatch itself (the outbound POST that produces these
 * rows) is a later slice; this screen reads the log back.
 */
export function WebhookDeliveryScreen({
  organizationSlug,
  organizationName,
  endpointId,
  client,
}: WebhookDeliveryScreenProps) {
  const api = client ?? browserApiClient();

  const [rows, setRows] = useState<readonly WebhookDeliveryView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const page = useQuery({
    queryKey: ['webhook-deliveries', organizationSlug, endpointId, cursor ?? 'first'],
    queryFn: async () => {
      const result = await listWebhookDeliveries(api, organizationSlug, endpointId, {
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
      setRows((existing) =>
        cursor === undefined ? result.deliveries : [...existing, ...result.deliveries],
      );
      return result;
    },
  });

  const nextCursor = page.data?.nextCursor ?? null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Webhook deliveries"
      description="Recorded delivery attempts for this endpoint, most recent first. Status and response code only — no secret or payload is stored."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-webhook-deliveries-heading">
        <h2 id="tm-webhook-deliveries-heading" className="tm-eyebrow">
          Delivery attempts
        </h2>

        {page.isError ? (
          <InlineAlert tone="danger" title="Could not load the delivery log" live>
            {describeError(page.error)}
          </InlineAlert>
        ) : null}

        {page.isPending && rows.length === 0 ? (
          <LoadingRegion label="Loading the delivery log.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!page.isPending && !page.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No deliveries yet">
            This endpoint has no recorded delivery attempts.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <table className="tm-table" aria-label="Webhook delivery attempts">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Response</th>
                <th scope="col">Attempted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <StatusDot tone={row.status === 'success' ? 'success' : 'danger'}>
                      {row.status === 'success' ? 'Success' : 'Failure'}
                    </StatusDot>
                  </td>
                  <td className="tm-mono">{row.responseCode ?? '—'}</td>
                  <td>{new Date(row.attemptedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {nextCursor !== null ? (
          <div className="tm-row">
            <Button
              type="button"
              tone="outline"
              size="accessible"
              loading={page.isFetching}
              loadingLabel="Loading"
              onClick={() => setCursor(nextCursor)}
            >
              Load older attempts
            </Button>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
