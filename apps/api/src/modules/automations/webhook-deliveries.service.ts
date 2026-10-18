import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository.js';

/**
 * Automations webhook deliveries (module 17, x221) — the guarded internal record helper.
 *
 * This slice is the **read surface** (the controller) plus this **guarded write helper**. Delivery
 * rows are never written from an HTTP body: they are produced by the in-app dispatch path, which
 * calls {@link WebhookDeliveriesService.recordDelivery} with an outcome. There is no external egress
 * in this slice — the dispatcher that performs the outbound POST is a later slice; this is the
 * tenant-scoped, validated write it will record through.
 *
 * The guard is threefold and holds regardless of the caller:
 *
 * 1. **Tenant scope before write.** The target endpoint is resolved within the acting tenant first;
 *    a cross-tenant or unknown `endpointId` is refused (`webhook_endpoint_not_found`) with no write,
 *    so a delivery row can never be attached to another studio's endpoint.
 * 2. **Status is allowlisted.** An off-list `status` is refused before any write — the column only
 *    ever holds a known token.
 * 3. **No secret, no body — structurally.** {@link RecordDeliveryOutcome} carries only `status` and
 *    an optional numeric `responseCode`; there is no field for the signing secret or the request /
 *    response body, so a recorded row cannot carry either.
 */

/** The outcome tokens a delivery attempt may record. An allowlist; an off-list value is refused. */
export const WEBHOOK_DELIVERY_STATUSES = ['success', 'failure'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export function isWebhookDeliveryStatus(value: unknown): value is WebhookDeliveryStatus {
  return (
    typeof value === 'string' && (WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** The smallest and largest HTTP status code a response may carry. */
const MIN_RESPONSE_CODE = 100;
const MAX_RESPONSE_CODE = 599;

/**
 * What the dispatch path reports about one attempt. No `organizationId` (the context owns the
 * tenant) and — deliberately — no secret or body field.
 */
export interface RecordDeliveryOutcome {
  readonly endpointId: string;
  readonly status: WebhookDeliveryStatus;
  /** The HTTP status code the target answered with, or null when no response was received. */
  readonly responseCode: number | null;
}

@Injectable()
export class WebhookDeliveriesService {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WebhookDeliveriesRepository) private readonly deliveries: WebhookDeliveriesRepository,
  ) {}

  /**
   * Record one delivery attempt within the acting tenant. Resolves the endpoint tenant-scoped before
   * the write (404-shaped refusal on a cross-tenant / unknown id), rejects an off-list status or an
   * out-of-range response code, then appends the row. Returns the new delivery id.
   */
  async recordDelivery(context: TenantContext, outcome: RecordDeliveryOutcome): Promise<string> {
    if (!isWebhookDeliveryStatus(outcome.status)) {
      throw new ApiError(
        400,
        'validation_failed',
        'The delivery outcome is invalid',
        [{ field: 'status', message: `must be one of ${WEBHOOK_DELIVERY_STATUSES.join(', ')}` }],
        'webhook_delivery_status_off_list',
      );
    }
    if (outcome.responseCode !== null) {
      const code = outcome.responseCode;
      if (!Number.isSafeInteger(code) || code < MIN_RESPONSE_CODE || code > MAX_RESPONSE_CODE) {
        throw new ApiError(400, 'validation_failed', 'The delivery outcome is invalid', [
          {
            field: 'responseCode',
            message: `must be an HTTP status code between ${MIN_RESPONSE_CODE} and ${MAX_RESPONSE_CODE}, or null`,
          },
        ]);
      }
    }

    return this.database.transaction(context, async (runner) => {
      // Tenant scope before write: a cross-tenant or unknown endpoint is refused with no insert, so a
      // delivery row can never be attached to another studio's endpoint.
      const endpoint = await this.deliveries.findEndpoint(runner, context, outcome.endpointId);
      if (!endpoint) {
        throw new ApiError(
          404,
          'not_found',
          'The webhook endpoint was not found',
          undefined,
          'webhook_endpoint_not_found',
        );
      }
      return this.deliveries.record(runner, context, {
        endpointId: outcome.endpointId,
        status: outcome.status,
        responseCode: outcome.responseCode,
      });
    });
  }
}
