import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WebhookDeliveryRow } from '../../common/database/schema.js';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository.js';
import { WebhookDeliveriesService } from './webhook-deliveries.service.js';
import {
  WEBHOOK_EGRESS,
  egressRefusalMessage,
  resolveEgress,
  webhookEgressFromEnv,
} from './egress-resolve.js';
import type { WebhookEgressSettings } from './egress-resolve.js';

/**
 * Automations module 17 (x221) — webhook delivery log. The read/history surface for the endpoints
 * registered by x166: recorded delivery attempts per endpoint, newest first, keyset-paged.
 *
 * One route behind the four global guards, gated on `org.manage` (the same reuse the sibling
 * webhook routes make — no `automation.*` capability exists and this slice adds none):
 *
 * - `GET /v1/organizations/:orgSlug/automations/webhooks/:endpointId/deliveries`
 *
 * ## The security substance
 *
 * - **Resolve `:endpointId` before authorize.** The endpoint is resolved within the acting tenant
 *   first; a cross-tenant or unknown id is a 404 with no read of another tenant's endpoint confirmed,
 *   so the route cannot be used to probe whether another studio's endpoint exists.
 * - **`org.manage`, belt-and-braces.** The route gates on `org.manage`; the controller re-checks it
 *   with the real `authorize()` at org level (`projectId: null`, deny-by-default), so a principal the
 *   guard would refuse is a 403 here too.
 * - **The projection carries no secret and no body.** {@link WebhookDeliveryView} exposes only the
 *   outcome — `status`, an optional `responseCode`, and the attempt instant — never the endpoint
 *   secret or any request/response body. The delivery row itself stores neither (0097).
 * - **Bounded page.** `limit` is validated into `[1, MAX_PAGE_SIZE]`; `before` is an exclusive-upper
 *   keyset cursor, so the read is never unbounded.
 *
 * Writes of delivery rows are produced only by the in-app dispatch path through
 * {@link WebhookDeliveriesService.recordDelivery} (a later slice performs the outbound POST); there
 * is no external egress in this slice.
 */

/** R13 slice 2: injectable clock for the retry route (tests). */
export const WEBHOOK_DELIVERIES_CLOCK = Symbol('tmanage.automations.webhookDeliveriesClock');

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/**
 * What a caller is allowed to see of one delivery attempt. `organizationId` is deliberately absent —
 * the wire projection never echoes the tenant id — and there is no secret or body field.
 */
export interface WebhookDeliveryView {
  readonly id: string;
  readonly endpointId: string;
  readonly status: string;
  /** The HTTP status code the target answered with, or null when no response was received. */
  readonly responseCode: number | null;
  /** An ISO-8601 instant. */
  readonly attemptedAt: string;
  // ---- 0281 · R13 slice 2 ----
  readonly eventId: string | null;
  readonly eventKind: string | null;
  readonly attempt: number;
  /** When the next attempt is due (set on a pending row, or on a failed row with a retry left). */
  readonly nextAttemptAt: string | null;
  readonly durationMs: number | null;
  /** At most 500 chars of the target's answer. Never the request body, never a secret. */
  readonly responseExcerpt: string | null;
  /** 8 hex chars of the hash of the secret that signed the attempt. */
  readonly signatureKeyId: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: WebhookDeliveryRow): WebhookDeliveryView {
  return {
    id: row.id,
    endpointId: row.endpointId,
    status: row.status,
    responseCode: row.responseCode ?? null,
    attemptedAt: row.attemptedAt.toISOString(),
    eventId: row.eventId ?? null,
    eventKind: row.eventKind ?? null,
    attempt: row.attempt ?? 1,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    durationMs: row.durationMs ?? null,
    responseExcerpt: row.responseExcerpt ?? null,
    signatureKeyId: row.signatureKeyId ?? null,
  };
}

@Controller('v1/organizations/:orgSlug/automations/webhooks/:endpointId/deliveries')
export class WebhookDeliveriesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WebhookDeliveriesRepository) private readonly deliveries: WebhookDeliveriesRepository,
    @Optional()
    @Inject(WEBHOOK_EGRESS)
    private readonly egress: WebhookEgressSettings = webhookEgressFromEnv(),
    @Optional()
    @Inject(WEBHOOK_DELIVERIES_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * List one endpoint's delivery attempts, newest first, keyset-paged. Resolve-before-authorize on
   * `:endpointId` (404 on a cross-tenant / unknown id), then `org.manage` (403 on denial). Read-only.
   */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('endpointId') endpointId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<{
    readonly deliveries: readonly WebhookDeliveryView[];
    readonly nextCursor: string | null;
  }> {
    if (typeof endpointId !== 'string' || endpointId === '') {
      throw new ApiError(400, 'validation_failed', 'endpointId is required', [
        { field: 'endpointId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? DEFAULT_PAGE_SIZE : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_SIZE) {
      throw new ApiError(400, 'validation_failed', 'The request query is invalid', [
        { field: 'limit', message: `must be an integer between 1 and ${MAX_PAGE_SIZE}` },
      ]);
    }

    const beforeCursor = typeof before === 'string' && before !== '' ? before : undefined;

    // Resolve BEFORE authorize: tenant-scoped, so a cross-tenant / unknown id is a 404, not a 403.
    const endpoint = await this.database.read(context, (runner) =>
      this.deliveries.findEndpoint(runner, context, endpointId),
    );
    if (!endpoint) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'webhook_endpoint_not_found',
      );
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'webhook_delivery_read_denied',
      );
    }

    const rows = await this.database.read(context, (runner) =>
      this.deliveries.listByEndpoint(runner, context, endpointId, {
        limit: parsedLimit,
        ...(beforeCursor !== undefined ? { before: beforeCursor } : {}),
      }),
    );

    // A full page yields a cursor to the next (older) page; a short page is the end of the log.
    const nextCursor = rows.length === parsedLimit ? (rows[rows.length - 1]?.id ?? null) : null;
    return { deliveries: rows.map(toView), nextCursor };
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  /**
   * R13 slice 2 — retry one attempt by hand. Stages a new pending attempt (the next attempt number
   * for that event) which the worker delivers on its next sweep: signed now, with the endpoint's
   * current secret, through the same egress guard. Refused when the attempt carries no event (a
   * pre-0281 row), is already queued, or the endpoint cannot be delivered to right now. The
   * capability stays `org.manage`.
   */
  @Post(':deliveryId/retry')
  @RequireCapability('org.manage')
  @HttpCode(202)
  async retry(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('endpointId') endpointId: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<{ readonly deliveryId: string; readonly attempt: number }> {
    if (
      typeof endpointId !== 'string' ||
      endpointId === '' ||
      typeof deliveryId !== 'string' ||
      deliveryId === ''
    ) {
      throw new ApiError(400, 'validation_failed', 'endpointId and deliveryId are required', [
        { field: 'deliveryId', message: 'must be a non-empty string' },
      ]);
    }
    const endpoint = await this.database.read(context, (runner) =>
      this.deliveries.findEndpoint(runner, context, endpointId),
    );
    if (!endpoint) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'webhook_endpoint_not_found',
      );
    }
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'webhook_retry_denied');
    }
    const delivery = await this.database.read(context, (runner) =>
      this.deliveries.findDelivery(runner, context, endpointId, deliveryId),
    );
    if (!delivery) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'webhook_delivery_not_found',
      );
    }
    if (!delivery.eventId || !delivery.eventKind) {
      throw new ApiError(
        409,
        'conflict',
        'This attempt predates retries and cannot be resent',
        undefined,
        'webhook_delivery_no_event',
      );
    }
    if (delivery.status === 'pending' || delivery.status === 'sending') {
      throw new ApiError(
        409,
        'conflict',
        'This attempt is already queued',
        undefined,
        'webhook_delivery_already_queued',
      );
    }
    if (endpoint.status !== 'active' || !endpoint.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'Resume or enable the webhook before retrying',
        undefined,
        'webhook_not_active',
      );
    }
    const verdict = await resolveEgress(endpoint.url, this.egress);
    if (!verdict.ok) {
      throw new ApiError(
        400,
        'validation_failed',
        'The webhook URL cannot be delivered to',
        [{ field: 'url', message: egressRefusalMessage(verdict.reason) }],
        `webhook_egress_${verdict.reason}`,
      );
    }
    const eventId = delivery.eventId;
    const eventKind = delivery.eventKind;
    return this.database.transaction(context, async (runner) => {
      const attempt = (await this.deliveries.lastAttempt(runner, context, endpointId, eventId)) + 1;
      const [id] = await this.deliveries.stagePending(runner, context, [
        { endpointId, eventId, eventKind, attempt, nextAttemptAt: this.now() },
      ]);
      return { deliveryId: id as string, attempt };
    });
  }

  private mayManageOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * Automations webhook-deliveries wiring (x221) — a self-contained module registered from
 * `app.module.ts`, file-disjoint from every other module. The repository is a stateless collection
 * of tenant-scoped reads/writes; the service is the guarded internal record helper for the (later)
 * dispatch path, constructed with the `@Global` `TENANT_DATABASE` and exported for that use.
 */
@Module({})
export class WebhookDeliveriesModule {
  static register(): DynamicModule {
    return {
      module: WebhookDeliveriesModule,
      providers: [
        {
          provide: WebhookDeliveriesRepository,
          useFactory: () => new WebhookDeliveriesRepository(),
        },
        { provide: WEBHOOK_EGRESS, useFactory: () => webhookEgressFromEnv() },
        {
          provide: WebhookDeliveriesService,
          useFactory: (database: TenantDatabase, repository: WebhookDeliveriesRepository) =>
            new WebhookDeliveriesService(database, repository),
          inject: [TENANT_DATABASE, WebhookDeliveriesRepository],
        },
      ],
      // R13 slice 2: the retry route re-resolves the URL against the deployment's own hosts.
      controllers: [WebhookDeliveriesController],
      exports: [WebhookDeliveriesService],
    };
  }
}
