import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WebhookEndpointRow } from '../../common/database/schema.js';
import { WebhooksRepository } from './webhooks.repository.js';
import { checkWebhookUrl } from './url-guard.js';

/**
 * Automations module 17 (x166) — outbound webhook endpoints (register / list / disable).
 *
 * Audit rank #2 ("Automations Missing — webhooks"). This slice **registers and validates** endpoints
 * only; actual delivery/dispatch to third parties is a later slice (external egress + retry infra,
 * Needs-Peter). Three routes behind the four global guards, gated on `org.manage` (there is no
 * dedicated `automation.*` capability and this slice adds none — the same reuse `usage` makes):
 *
 * - `POST   /v1/organizations/:orgSlug/automations/webhooks` — register.
 * - `GET    /v1/organizations/:orgSlug/automations/webhooks` — list.
 * - `PATCH  /v1/organizations/:orgSlug/automations/webhooks/:id` — enable / disable.
 *
 * ## The security substance
 *
 * - **SSRF at the write.** The URL is judged by {@link checkWebhookUrl} — https only, a public host,
 *   never localhost / private / link-local / loopback / metadata. A rejected URL is a 400 with no
 *   row written (`url-guard.ts` carries the rule and the reasoning).
 * - **The event kind is allowlisted.** An off-list `eventKind` is a 400 before any write.
 * - **The secret is stored hashed, never echoed.** The caller supplies a signing secret; only its
 *   SHA-256 digest is stored, and no read ever returns it — {@link WebhookEndpointView} has no
 *   `secret` field, so it *cannot* leak through the projection.
 * - **Resolve before authorize on `:id`.** A PATCH resolves the endpoint within the tenant first; a
 *   cross-tenant or unknown id is a 404 with no write, so the route cannot confirm another tenant's
 *   endpoint exists.
 * - **`org.manage`, belt-and-braces.** The route gates on `org.manage`; the controller re-checks it
 *   with the real `authorize()` at org level, so a principal the guard would refuse is a 403 here
 *   too — the same posture the sibling org-level reads take.
 */

/**
 * The event kinds an endpoint may subscribe to. An allowlist, not free text: an off-list value is a
 * 400. Kept in code (not an ENUM) so a new kind is a code change reviewed with the delivery that
 * emits it, the same division `work_forms` field types use.
 */
export const WEBHOOK_EVENT_KINDS = [
  'work.created',
  'work.updated',
  'work.completed',
  'approval.decided',
  'document.published',
  'client_request.created',
] as const;

export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

function isWebhookEventKind(value: unknown): value is WebhookEventKind {
  return typeof value === 'string' && (WEBHOOK_EVENT_KINDS as readonly string[]).includes(value);
}

/** `webhook_endpoints.url` is `VARCHAR(2048)`. */
const MAX_URL_LENGTH = 2048;
/** A signing secret must be long enough to be a real secret; the digest it becomes is fixed-width. */
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 512;

/**
 * What a caller is allowed to see of one webhook endpoint. `organizationId` is deliberately absent —
 * the wire projection never echoes the tenant id — and **there is no `secret`/`secretHash` field**:
 * the signing secret cannot leak through this projection because it is not part of it.
 */
export interface WebhookEndpointView {
  readonly id: string;
  readonly url: string;
  readonly eventKind: string;
  readonly enabled: boolean;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: WebhookEndpointRow): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    eventKind: row.eventKind,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** SHA-256 (hex) of the signing secret — what is stored, never the plaintext. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

interface RegisterWebhookBody {
  readonly url?: unknown;
  readonly eventKind?: unknown;
  readonly secret?: unknown;
}

interface PatchWebhookBody {
  readonly enabled?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations/webhooks')
export class WebhooksController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WebhooksRepository) private readonly webhooks: WebhooksRepository,
  ) {}

  /** List the organization's webhook endpoints, newest first. Secrets are never returned. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly endpoints: readonly WebhookEndpointView[] }> {
    this.requireOrgManage(principal, context);
    const rows = await this.database.read(context, (runner) => this.webhooks.list(runner, context));
    return { endpoints: rows.map(toView) };
  }

  /**
   * Register a webhook endpoint. The URL is SSRF-guarded and the event kind allowlisted before any
   * write; the signing secret is stored as a SHA-256 digest and never echoed. A 201 with the view
   * (no secret) on success.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async register(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: RegisterWebhookBody,
  ): Promise<WebhookEndpointView> {
    this.requireOrgManage(principal, context);

    const url = typeof body?.url === 'string' ? body.url.trim() : undefined;
    const secret = typeof body?.secret === 'string' ? body.secret : undefined;

    const details: { field: string; message: string }[] = [];

    if (!url) {
      details.push({ field: 'url', message: 'must be a non-empty string' });
    } else if (url.length > MAX_URL_LENGTH) {
      details.push({ field: 'url', message: `must be ${MAX_URL_LENGTH} characters or fewer` });
    } else {
      const verdict = checkWebhookUrl(url);
      if (!verdict.ok) details.push({ field: 'url', message: verdict.reason });
    }

    if (!isWebhookEventKind(body?.eventKind)) {
      details.push({
        field: 'eventKind',
        message: `must be one of ${WEBHOOK_EVENT_KINDS.join(', ')}`,
      });
    }

    if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
      details.push({
        field: 'secret',
        message: `must be at least ${MIN_SECRET_LENGTH} characters`,
      });
    } else if (secret.length > MAX_SECRET_LENGTH) {
      details.push({
        field: 'secret',
        message: `must be ${MAX_SECRET_LENGTH} characters or fewer`,
      });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the checks above, which TypeScript cannot see through.
    if (!url || !isWebhookEventKind(body?.eventKind) || secret === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const created = await this.database.transaction(context, (runner) =>
      this.webhooks.create(runner, context, {
        url,
        eventKind: body.eventKind as WebhookEventKind,
        secretHash: hashSecret(secret),
        createdBy: context.userId,
      }),
    );
    return toView(created);
  }

  /**
   * Enable or disable an endpoint. Tenant-scoped resolve before the change: an unknown or
   * cross-tenant id is a 404 with no write. Only `enabled` may change (the 0066 trigger enforces the
   * rest at the engine).
   */
  @Patch(':id')
  @RequireCapability('org.manage')
  async patch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: PatchWebhookBody,
  ): Promise<WebhookEndpointView> {
    this.requireOrgManage(principal, context);

    if (typeof id !== 'string' || id === '') {
      throw new ApiError(400, 'validation_failed', 'id is required', [
        { field: 'id', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof body?.enabled !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'enabled', message: 'must be a boolean' },
      ]);
    }

    const updated = await this.database.transaction(context, async (runner) => {
      // Resolve before authorize/act: a cross-tenant or unknown id is a 404, not a silent no-op that
      // confirms another tenant's endpoint exists.
      const existing = await this.webhooks.findById(runner, context, id);
      if (!existing) return null;
      return this.webhooks.setEnabled(runner, context, id, body.enabled as boolean);
    });

    if (!updated) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'webhook_not_found');
    }
    return toView(updated);
  }

  /**
   * Re-check `org.manage` with the real policy at org level — the belt-and-braces half of the
   * route's `CapabilityGuard`. A principal the check refuses is a 403 `forbidden`, the same envelope
   * as every sibling, leaking no reason.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'webhook_manage_denied');
    }
  }
}

/**
 * Automations webhooks wiring (x166) — a self-contained module registered from `app.module.ts` (the
 * shared append point), file-disjoint from every other module. The repository is a stateless
 * collection of tenant-scoped reads/writes, constructed here; the controller injects it and the
 * `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class WebhooksModule {
  static register(): DynamicModule {
    return {
      module: WebhooksModule,
      providers: [{ provide: WebhooksRepository, useFactory: () => new WebhooksRepository() }],
      controllers: [WebhooksController],
    };
  }
}
