import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Optional,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import {
  Ctx,
  CurrentPrincipal,
  NoTenant,
  Public,
  RequireCapability,
} from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WebhookEndpointRow } from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { WebhooksRepository } from './webhooks.repository.js';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository.js';
import { checkWebhookUrl } from './url-guard.js';
import { egressRefusalMessage, resolveEgress, webhookEgressFromEnv } from './egress-resolve.js';
import type { WebhookEgressSettings } from './egress-resolve.js';
import {
  WEBHOOK_SECRET_OVERLAP_MS,
  generateWebhookSecret,
  hashWebhookSecret,
  signatureKeyId,
} from './webhook-signing.js';
import {
  WEBHOOK_EVENT_KINDS,
  eventFiresKind,
  isWebhookEventKind,
  outboxTypesFor,
  parseEventsJson,
  webhookEventCatalogue,
} from './webhook-event-catalog.js';
import type { WebhookEventKind } from './webhook-event-catalog.js';

/**
 * Automations module 17 (x166) — outbound webhook endpoints; v2 since R13 slice 2 (54-03 + 56-08).
 *
 * Routes behind the four global guards, gated on `org.manage` — there is still no dedicated
 * `automation.*` capability, and this slice adds none (the same reuse `usage` makes):
 *
 * - `GET   …/automations/webhooks` — list.
 * - `POST  …/automations/webhooks` — register; returns the signing secret **once**.
 * - `PATCH …/automations/webhooks/:id` — enable / disable, subscribed events, description.
 * - `POST  …/automations/webhooks/:id/rotate-secret` — new secret (returned once); the previous
 *   one keeps signing for 24 h.
 * - `POST  …/automations/webhooks/:id/pause` | `…/resume`.
 * - `POST  …/automations/webhooks/:id/replay {from,to}` — re-queue past events: a window of at
 *   most 7 days, at most 10 000 events, at most once an hour per endpoint.
 * - `GET   /v1/public/webhook-events` — the public event catalogue (no auth, no data).
 *
 * ## The security substance
 *
 * - **SSRF at the write and at every delivery.** The URL is judged as written by
 *   {@link checkWebhookUrl}; resume / replay (and the worker, on every attempt) re-resolve it and
 *   refuse a private / loopback / metadata answer or TManage's own host (`egress-resolve.ts`).
 * - **The event kinds are allowlisted** against the catalogue built from the outbox events.
 * - **The secret is never stored in plaintext and never read back.** At rest it is a FieldCipher
 *   envelope (`webhook_secret`, AAD bound to the endpoint id) plus its SHA-256; the plaintext is in
 *   exactly two responses — create and rotate. {@link WebhookEndpointView} has no secret field.
 *   Keyless (no `FIELD_CIPHER_KEYS`), an endpoint is created `needs_rotation` and nothing is ever
 *   delivered to it — never a plaintext fallback.
 * - **Resolve before authorize on `:id`.** A cross-tenant or unknown id is a 404 with no write.
 * - **`org.manage`, belt-and-braces**, re-checked with the real `authorize()`.
 * - **Audited:** `webhook.secret_rotated | paused | resumed | replayed`, key ids only.
 */

/** The legacy constant, now the catalogue's kinds. */
export { WEBHOOK_EVENT_KINDS };
export type { WebhookEventKind };

/** `webhook_endpoints.url` is `VARCHAR(2048)`. */
const MAX_URL_LENGTH = 2048;
/** A caller-supplied signing secret must be long enough to be a real secret. */
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 300;
/** Replay limits (54-03 §4.1). */
export const REPLAY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REPLAY_MAX_EVENTS = 10_000;
export const REPLAY_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** What the v2 routes need beyond the repository. Every field has a production default. */
export const WEBHOOKS_V2_DEPS = Symbol('tmanage.automations.webhooksV2Deps');

export interface WebhooksV2Deps {
  readonly cipher?: FieldCipher;
  readonly audit?: Pick<AuditEventsRepository, 'append' | 'list'>;
  readonly deliveries?: WebhookDeliveriesRepository;
  readonly egress?: WebhookEgressSettings;
  readonly now?: () => Date;
}

/**
 * What a caller is allowed to see of one webhook endpoint. `organizationId` is deliberately absent,
 * and **there is no secret field of any kind**: `signingKeyId` is 8 hex chars of the secret's hash,
 * the same id the delivery rows record, so a receiver can tell which secret signed.
 */
export interface WebhookEndpointView {
  readonly id: string;
  readonly url: string;
  /** The first subscribed kind (legacy single-kind field). */
  readonly eventKind: string;
  readonly events: readonly string[];
  readonly description: string | null;
  readonly enabled: boolean;
  /** 'active' | 'paused' | 'needs_rotation'. */
  readonly status: string;
  readonly failureStreak: number;
  readonly pausedReason: string | null;
  readonly signingKeyId: string | null;
  readonly secretRotatedAt: string | null;
  /** While set and in the future, deliveries carry a second signature from the previous secret. */
  readonly previousSecretExpiresAt: string | null;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: WebhookEndpointRow): WebhookEndpointView {
  const events = parseEventsJson(row.eventsJson);
  return {
    id: row.id,
    url: row.url,
    eventKind: row.eventKind,
    events: events.length > 0 ? events : [row.eventKind],
    description: row.description ?? null,
    enabled: row.enabled,
    status: row.status ?? 'active',
    failureStreak: row.failureStreak ?? 0,
    pausedReason: row.pausedReason ?? null,
    signingKeyId: row.secretEnc ? signatureKeyId(row.secretHash) : null,
    secretRotatedAt: row.secretRotatedAt ? row.secretRotatedAt.toISOString() : null,
    previousSecretExpiresAt: row.secretPrevExpiresAt ? row.secretPrevExpiresAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The view plus the plaintext secret — create and rotate only. */
export type WebhookEndpointWithSecret = WebhookEndpointView & { readonly secret: string | null };

interface RegisterWebhookBody {
  readonly url?: unknown;
  readonly eventKind?: unknown;
  readonly events?: unknown;
  readonly description?: unknown;
  readonly secret?: unknown;
}

interface PatchWebhookBody {
  readonly enabled?: unknown;
  readonly events?: unknown;
  readonly description?: unknown;
}

interface ReplayBody {
  readonly from?: unknown;
  readonly to?: unknown;
}

type Detail = { field: string; message: string };

function invalid(details: readonly Detail[]): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', details);
}

/** `events` (array) wins over the legacy `eventKind`; returns null and a detail when invalid. */
function readEvents(
  events: unknown,
  eventKind: unknown,
  details: Detail[],
): readonly WebhookEventKind[] | null {
  if (events !== undefined) {
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > WEBHOOK_EVENT_KINDS.length
    ) {
      details.push({ field: 'events', message: 'must be a non-empty array of event kinds' });
      return null;
    }
    const bad = events.filter((kind) => !isWebhookEventKind(kind));
    if (bad.length > 0) {
      details.push({
        field: 'events',
        message: `every entry must be one of ${WEBHOOK_EVENT_KINDS.join(', ')}`,
      });
      return null;
    }
    return [...new Set(events as WebhookEventKind[])];
  }
  if (!isWebhookEventKind(eventKind)) {
    details.push({
      field: 'eventKind',
      message: `must be one of ${WEBHOOK_EVENT_KINDS.join(', ')}`,
    });
    return null;
  }
  return [eventKind];
}

function readDescription(value: unknown, details: Detail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `must be a string of ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
    });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

@Controller('v1/organizations/:orgSlug/automations/webhooks')
export class WebhooksController {
  private readonly cipher: FieldCipher;
  private readonly audit: Pick<AuditEventsRepository, 'append' | 'list'>;
  private readonly deliveries: WebhookDeliveriesRepository;
  private readonly egress: WebhookEgressSettings;
  private readonly now: () => Date;

  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WebhooksRepository) private readonly webhooks: WebhooksRepository,
    @Optional() @Inject(WEBHOOKS_V2_DEPS) deps: WebhooksV2Deps = {},
  ) {
    this.cipher = deps.cipher ?? createFieldCipher(loadFieldCipherKeyring(process.env));
    this.audit = deps.audit ?? new AuditEventsRepository();
    this.deliveries = deps.deliveries ?? new WebhookDeliveriesRepository();
    this.egress = deps.egress ?? webhookEgressFromEnv();
    this.now = deps.now ?? (() => new Date());
  }

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
   * Register a webhook endpoint. The URL is SSRF-guarded and the event kinds allowlisted before any
   * write. Without a caller secret one is generated and returned **once** (`secret`); a caller who
   * supplied their own gets `secret: null` (they already hold it).
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async register(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: RegisterWebhookBody,
  ): Promise<WebhookEndpointWithSecret> {
    this.requireOrgManage(principal, context);

    const url = typeof body?.url === 'string' ? body.url.trim() : undefined;
    const supplied = body?.secret;
    const details: Detail[] = [];

    if (!url) {
      details.push({ field: 'url', message: 'must be a non-empty string' });
    } else if (url.length > MAX_URL_LENGTH) {
      details.push({ field: 'url', message: `must be ${MAX_URL_LENGTH} characters or fewer` });
    } else {
      const verdict = checkWebhookUrl(url);
      if (!verdict.ok) details.push({ field: 'url', message: verdict.reason });
    }

    const events = readEvents(body?.events, body?.eventKind, details);
    const description = readDescription(body?.description, details);

    if (supplied !== undefined) {
      if (typeof supplied !== 'string' || supplied.length < MIN_SECRET_LENGTH) {
        details.push({
          field: 'secret',
          message: `must be at least ${MIN_SECRET_LENGTH} characters`,
        });
      } else if (supplied.length > MAX_SECRET_LENGTH) {
        details.push({
          field: 'secret',
          message: `must be ${MAX_SECRET_LENGTH} characters or fewer`,
        });
      }
    }

    if (details.length > 0 || !url || events === null) throw invalid(details);

    const generated = typeof supplied === 'string' ? null : generateWebhookSecret();
    const secret = generated ?? (supplied as string);
    const id = uuidv7();
    // Keyless: the row is written without a readable secret and waits for a rotation — nothing is
    // ever stored in plaintext.
    const secretEnc = this.cipher.enabled
      ? this.cipher.encrypt(secret, { purpose: 'webhook_secret', ownerId: id })
      : null;

    const created = await this.database.transaction(context, (runner) =>
      this.webhooks.create(runner, context, {
        id,
        url,
        eventKind: events[0] as WebhookEventKind,
        events,
        description: description ?? null,
        secretHash: hashWebhookSecret(secret),
        secretEnc,
        status: secretEnc === null ? 'needs_rotation' : 'active',
        createdBy: context.userId,
      }),
    );
    return { ...toView(created), secret: secretEnc !== null ? generated : null };
  }

  /**
   * Enable / disable, change the subscribed events, or the description. Tenant-scoped resolve
   * before the change: an unknown or cross-tenant id is a 404 with no write.
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
    this.requireId(id);

    const details: Detail[] = [];
    const enabled = body?.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      details.push({ field: 'enabled', message: 'must be a boolean' });
    }
    const events = body?.events === undefined ? undefined : readEvents(body.events, null, details);
    const description = readDescription(body?.description, details);
    if (enabled === undefined && body?.events === undefined && body?.description === undefined) {
      details.push({ field: 'enabled', message: 'must be a boolean' });
    }
    if (details.length > 0) throw invalid(details);

    const updated = await this.database.transaction(context, async (runner) => {
      // Resolve before authorize/act: a cross-tenant or unknown id is a 404, not a silent no-op
      // that confirms another tenant's endpoint exists.
      const existing = await this.webhooks.findById(runner, context, id);
      if (!existing) return null;
      let row: WebhookEndpointRow | null = existing;
      if (typeof enabled === 'boolean') {
        row = await this.webhooks.setEnabled(runner, context, id, enabled);
      }
      if (events !== undefined || description !== undefined) {
        row = await this.webhooks.updateSettings(runner, context, id, {
          ...(events !== undefined && events !== null ? { events } : {}),
          ...(description !== undefined ? { description } : {}),
        });
      }
      return row;
    });

    if (!updated) throw this.notFound();
    return toView(updated);
  }

  /**
   * Rotate the signing secret. The new plaintext is returned once; the previous secret keeps
   * signing (a second `v1=`) for 24 h. Needs `FIELD_CIPHER_KEYS` — keyless is a 409.
   */
  @Post(':id/rotate-secret')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async rotateSecret(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<WebhookEndpointWithSecret> {
    this.requireOrgManage(principal, context);
    this.requireId(id);
    if (!this.cipher.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'Webhook signing is not configured on this server',
        undefined,
        'webhook_signing_unavailable',
      );
    }

    const secret = generateWebhookSecret();
    const secretHash = hashWebhookSecret(secret);
    const now = this.now();
    const rotated = await this.database.transaction(context, async (runner) => {
      const existing = await this.webhooks.findById(runner, context, id);
      if (!existing) return null;
      const hadSecret = existing.secretEnc !== null && existing.secretEnc !== undefined;
      const row = await this.webhooks.rotateSecret(runner, context, id, {
        secretHash,
        secretEnc: this.cipher.encrypt(secret, { purpose: 'webhook_secret', ownerId: id }),
        secretPrevEnc: hadSecret ? (existing.secretEnc as string) : null,
        secretPrevHash: hadSecret ? existing.secretHash : null,
        rotatedAt: now,
        prevExpiresAt: hadSecret ? new Date(now.getTime() + WEBHOOK_SECRET_OVERLAP_MS) : null,
      });
      await this.audit.append(runner, context, {
        action: 'webhook.secret_rotated',
        result: 'allowed',
        objectId: id,
        metadata: {
          key_id: signatureKeyId(secretHash),
          previous_key_id: hadSecret ? signatureKeyId(existing.secretHash) : null,
        },
      });
      return row;
    });
    if (!rotated) throw this.notFound();
    return { ...toView(rotated), secret };
  }

  /** Pause deliveries. Staged attempts are cancelled by the worker when their turn comes. */
  @Post(':id/pause')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async pause(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<WebhookEndpointView> {
    this.requireOrgManage(principal, context);
    this.requireId(id);
    const row = await this.database.transaction(context, async (runner) => {
      const existing = await this.webhooks.findById(runner, context, id);
      if (!existing) return null;
      const paused = await this.webhooks.setStatus(
        runner,
        context,
        id,
        'paused',
        'paused_by_admin',
      );
      await this.audit.append(runner, context, {
        action: 'webhook.paused',
        result: 'allowed',
        objectId: id,
        metadata: { reason: 'paused_by_admin' },
      });
      return paused;
    });
    if (!row) throw this.notFound();
    return toView(row);
  }

  /**
   * Resume a paused endpoint: clears the breaker's streak. The URL is re-resolved first — an
   * endpoint whose host now answers with a private address stays paused (400). An endpoint that
   * still needs a secret must be rotated, not resumed (409).
   */
  @Post(':id/resume')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async resume(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<WebhookEndpointView> {
    this.requireOrgManage(principal, context);
    this.requireId(id);
    const existing = await this.database.read(context, (runner) =>
      this.webhooks.findById(runner, context, id),
    );
    if (!existing) throw this.notFound();
    if (existing.status === 'needs_rotation') throw this.needsRotation();
    await this.requireReachable(existing.url);

    const row = await this.database.transaction(context, async (runner) => {
      const resumed = await this.webhooks.setStatus(runner, context, id, 'active', null);
      await this.audit.append(runner, context, {
        action: 'webhook.resumed',
        result: 'allowed',
        objectId: id,
        metadata: { previous_streak: existing.failureStreak ?? 0 },
      });
      return resumed;
    });
    if (!row) throw this.notFound();
    return toView(row);
  }

  /**
   * Re-queue the organization's past events of the endpoint's kinds in `[from, to]`. The worker
   * delivers them like new events (signed now, retried, breaker-counted). Caps: a window of at
   * most 7 days, at most 10 000 events, at most one replay per endpoint per hour (429).
   */
  @Post(':id/replay')
  @RequireCapability('org.manage')
  @HttpCode(202)
  async replay(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: ReplayBody,
  ): Promise<{ readonly queued: number }> {
    this.requireOrgManage(principal, context);
    this.requireId(id);
    const now = this.now();
    const from = readInstant(body?.from);
    const to = readInstant(body?.to);
    const details: Detail[] = [];
    if (from === null) details.push({ field: 'from', message: 'must be an ISO-8601 instant' });
    if (to === null) details.push({ field: 'to', message: 'must be an ISO-8601 instant' });
    if (from !== null && to !== null) {
      if (to.getTime() <= from.getTime()) {
        details.push({ field: 'to', message: 'must be after from' });
      } else if (to.getTime() - from.getTime() > REPLAY_MAX_WINDOW_MS) {
        details.push({ field: 'to', message: 'the window must be 7 days or shorter' });
      } else if (to.getTime() > now.getTime() + 60_000) {
        details.push({ field: 'to', message: 'must not be in the future' });
      }
    }
    if (details.length > 0 || from === null || to === null) throw invalid(details);

    const existing = await this.database.read(context, (runner) =>
      this.webhooks.findById(runner, context, id),
    );
    if (!existing) throw this.notFound();
    if (existing.status === 'needs_rotation') throw this.needsRotation();
    if (existing.status !== 'active' || !existing.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'Resume or enable the webhook before replaying events to it',
        undefined,
        'webhook_not_active',
      );
    }

    const kinds = parseEventsJson(existing.eventsJson);
    const lastReplay = await this.database.read(context, (runner) =>
      this.audit.list(runner, context, { action: 'webhook.replayed', objectId: id, limit: 1 }),
    );
    const last = lastReplay[0];
    if (last && now.getTime() - last.createdAt.getTime() < REPLAY_MIN_INTERVAL_MS) {
      throw new ApiError(
        429,
        'rate_limited',
        MESSAGES.rateLimited,
        undefined,
        'webhook_replay_hourly_cap',
      );
    }
    await this.requireReachable(existing.url);

    const events = await this.database.read(context, (runner) =>
      this.webhooks.listReplayableEvents(
        runner,
        context,
        outboxTypesFor(kinds),
        from,
        to,
        REPLAY_MAX_EVENTS + 1,
      ),
    );
    if (events.length > REPLAY_MAX_EVENTS) {
      throw invalid([
        {
          field: 'from',
          message: `the window holds more than ${REPLAY_MAX_EVENTS} events; narrow it`,
        },
      ]);
    }

    const staged = events.flatMap((event) =>
      kinds
        .filter((kind) => eventFiresKind(kind, event.type, event.payload))
        .map((kind) => ({
          endpointId: id,
          eventId: event.id,
          eventKind: kind,
          attempt: 1,
          nextAttemptAt: now,
        })),
    );

    await this.database.transaction(context, async (runner) => {
      if (staged.length > 0) await this.deliveries.stagePending(runner, context, staged);
      await this.audit.append(runner, context, {
        action: 'webhook.replayed',
        result: 'allowed',
        objectId: id,
        metadata: {
          events_queued: staged.length,
          window_minutes: Math.round((to.getTime() - from.getTime()) / 60_000),
        },
      });
    });
    return { queued: staged.length };
  }

  private async requireReachable(url: string): Promise<void> {
    const verdict = await resolveEgress(url, this.egress);
    if (!verdict.ok) {
      throw new ApiError(
        400,
        'validation_failed',
        'The webhook URL cannot be delivered to',
        [{ field: 'url', message: egressRefusalMessage(verdict.reason) }],
        `webhook_egress_${verdict.reason}`,
      );
    }
  }

  private requireId(id: string): void {
    if (typeof id !== 'string' || id === '') {
      throw new ApiError(400, 'validation_failed', 'id is required', [
        { field: 'id', message: 'must be a non-empty string' },
      ]);
    }
  }

  private notFound(): ApiError {
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'webhook_not_found');
  }

  private needsRotation(): ApiError {
    return new ApiError(
      409,
      'conflict',
      'Rotate the signing secret before using this webhook',
      undefined,
      'webhook_needs_rotation',
    );
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
 * R13 slice 2 — the public webhook event catalogue: kinds, payload fields, envelope, headers and
 * the signature scheme. Documentation, not data: no tenant, no auth, cacheable.
 */
@Controller('v1/public')
export class WebhookEventsPublicController {
  @Get('webhook-events')
  @Public()
  @NoTenant()
  @Header('Cache-Control', 'public, max-age=3600')
  catalogue(): ReturnType<typeof webhookEventCatalogue> {
    return webhookEventCatalogue();
  }
}

/**
 * Automations webhooks wiring (x166, v2 R13 slice 2) — a self-contained module registered from
 * `app.module.ts`. The repositories are stateless, constructed here; the v2 dependencies (cipher,
 * audit writer, egress settings) default inside the controller from the environment.
 */
@Module({})
export class WebhooksModule {
  static register(): DynamicModule {
    return {
      module: WebhooksModule,
      providers: [
        { provide: WebhooksRepository, useFactory: () => new WebhooksRepository() },
        {
          provide: WEBHOOKS_V2_DEPS,
          useFactory: (): WebhooksV2Deps => ({
            cipher: createFieldCipher(loadFieldCipherKeyring(process.env)),
            audit: new AuditEventsRepository(),
            deliveries: new WebhookDeliveriesRepository(),
            egress: webhookEgressFromEnv(),
          }),
        },
      ],
      controllers: [WebhooksController, WebhookEventsPublicController],
    };
  }
}
