import type { ApiClient } from './client';

/**
 * Automations webhook delivery log (module 17, x221).
 *
 * This module wraps the delivery-log API: list one endpoint's recorded delivery attempts, newest
 * first, keyset-paged. The one exported response shape is {@link WebhookDeliveryView}, paired Exact
 * with the API's `WebhookDeliveryView` in the contracts gate. A delivery record carries only the
 * outcome — a status, an optional HTTP response code, and the attempt instant — never the endpoint's
 * signing secret or any request/response body, so none of those appear here.
 */

/**
 * One recorded delivery attempt — paired Exact with the API's `WebhookDeliveryView`.
 * `organizationId` is absent on both sides, and there is no secret or body field.
 */
export interface WebhookDeliveryView {
  readonly id: string;
  readonly endpointId: string;
  readonly status: string;
  readonly responseCode: number | null;
  readonly attemptedAt: string;
  // ---- 0281 · R13 slice 2 ----
  readonly eventId: string | null;
  readonly eventKind: string | null;
  readonly attempt: number;
  readonly nextAttemptAt: string | null;
  readonly durationMs: number | null;
  /** At most 500 chars of the target's answer. */
  readonly responseExcerpt: string | null;
  readonly signatureKeyId: string | null;
}

/** One page of delivery attempts, with the keyset cursor for the next (older) page. */
export interface WebhookDeliveryPage {
  readonly deliveries: readonly WebhookDeliveryView[];
  readonly nextCursor: string | null;
}

function base(organizationSlug: string, endpointId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/webhooks/${encodeURIComponent(
    endpointId,
  )}/deliveries`;
}

/** List one endpoint's delivery attempts, newest first. `before` is the keyset cursor. */
export async function listWebhookDeliveries(
  client: ApiClient,
  organizationSlug: string,
  endpointId: string,
  options: { readonly limit?: number; readonly before?: string } = {},
): Promise<WebhookDeliveryPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.before !== undefined) params.set('before', options.before);
  const query = params.toString();
  const { data } = await client.request<WebhookDeliveryPage>({
    path:
      query === ''
        ? base(organizationSlug, endpointId)
        : `${base(organizationSlug, endpointId)}?${query}`,
  });
  return data;
}
