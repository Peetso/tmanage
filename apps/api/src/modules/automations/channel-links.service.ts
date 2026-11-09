import { createHash } from 'node:crypto';
import {
  CHANNEL_BOT_HOSTS,
  CHANNEL_TEST_KIND,
  encodeChannelBot,
  isChannelBotSecret,
  isChannelLocale,
  uuidv7,
} from '@tmanage/domain';
import type { ChannelBotDescriptor } from '@tmanage/domain';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { CHANNEL_LINK_KINDS } from '../../common/database/schema.js';
import type { ChannelLinkKind, IntegrationChannelLinkRow } from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { IntegrationConnectionsRepository } from './directory.repository.js';
import { type ChannelLinksRepository } from './channel-links.repository.js';
import { checkWebhookUrl } from './url-guard.js';
import { egressRefusalMessage, resolveEgress, webhookEgressFromEnv } from './egress-resolve.js';
import type { WebhookEgressSettings } from './egress-resolve.js';
import {
  WEBHOOK_EVENT_KINDS,
  isWebhookEventKind,
  parseEventsJson,
} from './webhook-event-catalog.js';

/**
 * R15-c (54-05 Slack + 54-06 Teams, Phase 0) — pasted incoming-webhook channel links.
 *
 * The security substance:
 *
 * - **The URL is a bearer credential.** Anyone holding a Slack / Teams incoming-webhook URL can post
 *   to that channel, so it is FieldCipher-encrypted at rest (purpose `integration_token`, AAD bound
 *   to the link id), never projected ({@link ChannelLinkView} has `urlHost` only), never in an audit
 *   row and never in the `integration_connections` config. Keyless, a link cannot be created (409).
 * - **SSRF.** https only; the host must be on the kind's allow-list (Slack `hooks.slack.com`; Teams
 *   `*.webhook.office.com`, `*.logic.azure.com`, `*.powerautomate.com`); the URL rules of
 *   `checkWebhookUrl`; and `resolveEgress` must answer public now. The worker resolves again at
 *   every send and pins the connection.
 * - **Events are allowlisted** against the 54-03 webhook catalogue.
 * - **Resolve before act on `:id`**: an unknown or cross-tenant id is a 404 with no write.
 */

export const CHANNEL_TEST_MIN_INTERVAL_MS = 60_000;
const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 300;
const KIND_NAMES: Readonly<Record<ChannelLinkKind, string>> = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

/** What a caller sees of one link. There is no URL field of any kind. */
export interface ChannelLinkView {
  readonly id: string;
  readonly kind: string;
  readonly connectionId: string;
  readonly projectId: string | null;
  readonly label: string | null;
  readonly urlHost: string;
  readonly events: readonly string[];
  readonly locale: string;
  readonly status: string;
  readonly failureStreak: number;
  readonly pausedReason: string | null;
  readonly lastPostedAt: string | null;
  readonly createdAt: string;
}

/** An explicit projection: a column added later is invisible until named here. */
export function toChannelLinkView(row: IntegrationChannelLinkRow): ChannelLinkView {
  return {
    id: row.id,
    kind: row.kind,
    connectionId: row.connectionId,
    projectId: row.projectId ?? null,
    label: row.externalChannelLabel ?? null,
    urlHost: row.urlHost,
    events: parseEventsJson(row.eventsJson),
    locale: row.locale,
    status: row.status,
    failureStreak: row.failureStreak,
    pausedReason: row.pausedReason ?? null,
    lastPostedAt: row.lastPostedAt ? row.lastPostedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function isChannelLinkKind(value: unknown): value is ChannelLinkKind {
  return typeof value === 'string' && (CHANNEL_LINK_KINDS as readonly string[]).includes(value);
}

/**
 * Whether `host` is an incoming-webhook host of `kind`. Teams: a tenant's `*.webhook.office.com`,
 * the classic connector host `outlook.office.com` (exact, R46 L2), or a Workflows trigger.
 */
export function channelHostAllowed(kind: ChannelLinkKind, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, '');
  if (kind === 'slack') return name === 'hooks.slack.com';
  if (name === 'outlook.office.com') return true;
  return ['.webhook.office.com', '.logic.azure.com', '.powerautomate.com'].some((suffix) =>
    name.endsWith(suffix),
  );
}

export type ChannelUrlVerdict =
  | { readonly ok: true; readonly url: string; readonly host: string; readonly channelId: string }
  | { readonly ok: false; readonly message: string };

/** The write-time rules for a pasted URL (before the DNS answer is checked). */
export function checkChannelUrl(kind: ChannelLinkKind, raw: unknown): ChannelUrlVerdict {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, message: 'must be a non-empty string' };
  }
  const value = raw.trim();
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, message: `must be ${String(MAX_URL_LENGTH)} characters or fewer` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: 'is not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'must use https' };
  if (url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) {
    return { ok: false, message: 'must not carry credentials or a port' };
  }
  if (!channelHostAllowed(kind, url.hostname)) {
    return {
      ok: false,
      message:
        kind === 'slack'
          ? 'must be a Slack incoming webhook (hooks.slack.com)'
          : 'must be a Teams incoming webhook or Workflows URL',
    };
  }
  const guard = checkWebhookUrl(value);
  if (!guard.ok) return { ok: false, message: guard.reason };
  return {
    ok: true,
    url: value,
    host: url.hostname.toLowerCase(),
    channelId: createHash('sha256').update(url.pathname, 'utf8').digest('hex'),
  };
}

export interface CreateChannelLinkBody {
  readonly webhookUrl?: unknown;
  readonly projectId?: unknown;
  readonly events?: unknown;
  readonly locale?: unknown;
  readonly label?: unknown;
}

export interface ChannelLinksDeps {
  readonly cipher?: FieldCipher;
  readonly audit?: Pick<AuditEventsRepository, 'append'>;
  readonly connections?: Pick<IntegrationConnectionsRepository, 'create'>;
  readonly egress?: WebhookEgressSettings;
  readonly now?: () => Date;
}

type Detail = { field: string; message: string };

function invalid(details: readonly Detail[]): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', details);
}

export class ChannelLinksService {
  private readonly cipher: FieldCipher;
  private readonly audit: Pick<AuditEventsRepository, 'append'>;
  private readonly connections: Pick<IntegrationConnectionsRepository, 'create'>;
  private readonly egress: WebhookEgressSettings;
  private readonly now: () => Date;

  constructor(
    private readonly database: TenantDatabase,
    private readonly links: ChannelLinksRepository,
    deps: ChannelLinksDeps = {},
  ) {
    this.cipher = deps.cipher ?? createFieldCipher(loadFieldCipherKeyring(process.env));
    this.audit = deps.audit ?? new AuditEventsRepository();
    this.connections = deps.connections ?? new IntegrationConnectionsRepository();
    this.egress = deps.egress ?? webhookEgressFromEnv();
    this.now = deps.now ?? (() => new Date());
  }

  async list(context: TenantContext): Promise<readonly ChannelLinkView[]> {
    const rows = await this.database.read(context, (runner) => this.links.list(runner, context));
    return rows.map(toChannelLinkView);
  }

  async create(
    context: TenantContext,
    kind: string,
    body: CreateChannelLinkBody,
  ): Promise<ChannelLinkView> {
    if (!isChannelLinkKind(kind)) throw this.notFound('channel_kind_not_found');
    const details: Detail[] = [];
    const verdict = checkChannelUrl(kind, body?.webhookUrl);
    if (!verdict.ok) details.push({ field: 'webhookUrl', message: verdict.message });

    const events = body?.events;
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > WEBHOOK_EVENT_KINDS.length ||
      !events.every(isWebhookEventKind)
    ) {
      details.push({
        field: 'events',
        message: `must be a non-empty array of ${WEBHOOK_EVENT_KINDS.join(', ')}`,
      });
    }
    const locale = body?.locale ?? 'en';
    if (!isChannelLocale(locale))
      details.push({ field: 'locale', message: "must be 'en' or 'ar'" });
    const rawLabel = body?.label;
    if (
      rawLabel !== undefined &&
      rawLabel !== null &&
      (typeof rawLabel !== 'string' || rawLabel.length > MAX_LABEL_LENGTH)
    ) {
      details.push({
        field: 'label',
        message: `must be ${String(MAX_LABEL_LENGTH)} characters or fewer`,
      });
    }
    const projectId = body?.projectId ?? null;
    if (projectId !== null && (typeof projectId !== 'string' || projectId === '')) {
      details.push({ field: 'projectId', message: 'must be a project id or null' });
    }
    if (details.length > 0 || !verdict.ok) throw invalid(details);
    if (!this.cipher.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'Channel notices need encryption keys on this server',
        undefined,
        'channel_links_unavailable',
      );
    }
    await this.requireReachable(verdict.url);

    const label = typeof rawLabel === 'string' && rawLabel.trim() !== '' ? rawLabel.trim() : null;
    const kinds = [...new Set(events as string[])];
    const scope = projectId as string | null;
    const id = uuidv7();
    const now = this.now();
    const row = await this.database.transaction(context, async (runner) => {
      if (scope !== null && !(await this.links.projectExists(runner, context, scope))) {
        throw invalid([{ field: 'projectId', message: 'is not a project of this organization' }]);
      }
      const connection =
        (await this.links.findConnection(runner, context, kind)) ??
        (await this.connections.create(runner, context, {
          appId: kind,
          label: label ?? KIND_NAMES[kind],
          status: 'connected',
          config: { label: label ?? KIND_NAMES[kind], locale: locale as string },
          createdBy: context.userId,
        }));
      if (
        await this.links.findDuplicate(runner, context, connection.id, verdict.channelId, scope)
      ) {
        throw new ApiError(
          409,
          'conflict',
          'This channel is already linked',
          undefined,
          'channel_link_exists',
        );
      }
      const created = await this.links.insert(
        runner,
        context,
        {
          id,
          connectionId: connection.id,
          kind,
          projectId: scope,
          externalChannelId: verdict.channelId,
          label,
          webhookUrlEnc: this.cipher.encrypt(verdict.url, {
            purpose: 'integration_token',
            ownerId: id,
          }),
          urlHost: verdict.host,
          events: kinds,
          locale: locale as string,
          createdBy: context.userId,
        },
        now,
      );
      await this.audit.append(runner, context, {
        action: 'channel_link.created',
        result: 'allowed',
        objectId: id,
        metadata: {
          kind,
          url_host: verdict.host,
          event_count: kinds.length,
          project_scoped: scope !== null,
        },
      });
      return created;
    });
    return toChannelLinkView(row);
  }

  /**
   * FIX5 one-click connectors. A channel picked after Connect: the link stores the bot descriptor
   * (channel + token, {@link encodeChannelBot}) where a webhook link stores its URL, encrypted the
   * same way. Events default to every notice kind; the owner narrows them on Channel notices.
   */
  async createBotLink(
    context: TenantContext,
    descriptor: ChannelBotDescriptor,
    body: { readonly label: string; readonly events?: unknown; readonly locale?: unknown },
  ): Promise<ChannelLinkView> {
    const kind: ChannelLinkKind = descriptor.provider;
    const events =
      body.events === undefined ? [...WEBHOOK_EVENT_KINDS] : (body.events as unknown[]);
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > WEBHOOK_EVENT_KINDS.length ||
      !events.every(isWebhookEventKind)
    ) {
      throw invalid([
        {
          field: 'events',
          message: `must be a non-empty array of ${WEBHOOK_EVENT_KINDS.join(', ')}`,
        },
      ]);
    }
    const locale = body.locale ?? 'en';
    if (!isChannelLocale(locale))
      throw invalid([{ field: 'locale', message: "must be 'en' or 'ar'" }]);
    if (!this.cipher.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'Channel notices need encryption keys on this server',
        undefined,
        'channel_links_unavailable',
      );
    }
    const label = body.label.trim().slice(0, MAX_LABEL_LENGTH) || KIND_NAMES[kind];
    const channelKey =
      descriptor.provider === 'slack'
        ? `bot:slack:${descriptor.channelId}`
        : `bot:teams:${descriptor.teamId}:${descriptor.channelId}`;
    const channelId = createHash('sha256').update(channelKey, 'utf8').digest('hex');
    const host = CHANNEL_BOT_HOSTS[kind];
    const id = uuidv7();
    const now = this.now();
    const row = await this.database.transaction(context, async (runner) => {
      const connection =
        (await this.links.findConnection(runner, context, kind)) ??
        (await this.connections.create(runner, context, {
          appId: kind,
          label: KIND_NAMES[kind],
          status: 'connected',
          config: { label: KIND_NAMES[kind], locale },
          createdBy: context.userId,
        }));
      if (await this.links.findDuplicate(runner, context, connection.id, channelId, null)) {
        throw new ApiError(
          409,
          'conflict',
          'This channel is already linked',
          undefined,
          'channel_link_exists',
        );
      }
      const kinds = [...new Set(events as string[])];
      const created = await this.links.insert(
        runner,
        context,
        {
          id,
          connectionId: connection.id,
          kind,
          projectId: null,
          externalChannelId: channelId,
          label,
          webhookUrlEnc: this.cipher.encrypt(encodeChannelBot(descriptor), {
            purpose: 'integration_token',
            ownerId: id,
          }),
          urlHost: host,
          events: kinds,
          locale,
          createdBy: context.userId,
        },
        now,
      );
      await this.audit.append(runner, context, {
        action: 'channel_link.created',
        result: 'allowed',
        objectId: id,
        metadata: { kind, url_host: host, event_count: kinds.length, project_scoped: false },
      });
      return created;
    });
    return toChannelLinkView(row);
  }

  /** FIX5. Disconnect drops every bot link of the provider; pasted webhook links stay. */
  async removeBotLinks(context: TenantContext, kind: ChannelLinkKind): Promise<number> {
    return this.database.transaction(context, async (runner) => {
      const removed = await this.links.removeByHost(runner, context, kind, CHANNEL_BOT_HOSTS[kind]);
      if (removed > 0) {
        await this.audit.append(runner, context, {
          action: 'channel_link.removed',
          result: 'allowed',
          objectId: null,
          metadata: { kind, url_host: CHANNEL_BOT_HOSTS[kind], count: removed },
        });
      }
      return removed;
    });
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    const removed = await this.database.transaction(context, async (runner) => {
      const existing = await this.links.findById(runner, context, id);
      if (!existing) return false;
      await this.links.remove(runner, context, id);
      await this.audit.append(runner, context, {
        action: 'channel_link.removed',
        result: 'allowed',
        objectId: id,
        metadata: { kind: existing.kind, url_host: existing.urlHost },
      });
      return true;
    });
    if (!removed) throw this.notFound();
  }

  /** Stage one `integration.test` post; at most one a minute per link (429). */
  async test(context: TenantContext, id: string): Promise<{ readonly staged: true }> {
    const now = this.now();
    await this.database.transaction(context, async (runner) => {
      const link = await this.links.findById(runner, context, id);
      if (!link) throw this.notFound();
      if (link.status !== 'active') {
        throw new ApiError(
          409,
          'conflict',
          'Resume this channel before testing it',
          undefined,
          'channel_link_paused',
        );
      }
      const last = await this.links.lastTestPostAt(runner, context, id, CHANNEL_TEST_KIND);
      if (last && now.getTime() - last.getTime() < CHANNEL_TEST_MIN_INTERVAL_MS) {
        throw new ApiError(
          429,
          'rate_limited',
          MESSAGES.rateLimited,
          undefined,
          'channel_test_throttled',
        );
      }
      await this.links.stageTestPost(runner, context, link, CHANNEL_TEST_KIND, now);
    });
    return { staged: true };
  }

  /** Back to active; the URL is decrypted and re-resolved first (still public, still allowed). */
  async resume(context: TenantContext, id: string): Promise<ChannelLinkView> {
    const existing = await this.database.read(context, (runner) =>
      this.links.findById(runner, context, id),
    );
    if (!existing) throw this.notFound();
    let url: string;
    try {
      url = this.cipher.decrypt(existing.webhookUrlEnc, {
        purpose: 'integration_token',
        ownerId: id,
      });
    } catch {
      throw new ApiError(
        409,
        'conflict',
        'This channel link cannot be read; remove it and paste the URL again',
        undefined,
        'channel_link_unreadable',
      );
    }
    // FIX5: a bot link posts to the provider's fixed API host, not to a pasted URL.
    if (!isChannelBotSecret(url)) await this.requireReachable(url);
    const row = await this.database.transaction(context, async (runner) => {
      const resumed = await this.links.resume(runner, context, id, this.now());
      await this.audit.append(runner, context, {
        action: 'channel_link.resumed',
        result: 'allowed',
        objectId: id,
        metadata: { kind: existing.kind, previous_streak: existing.failureStreak },
      });
      return resumed;
    });
    if (!row) throw this.notFound();
    return toChannelLinkView(row);
  }

  private async requireReachable(url: string): Promise<void> {
    const verdict = await resolveEgress(url, this.egress);
    if (!verdict.ok) {
      throw new ApiError(
        400,
        'validation_failed',
        'The webhook URL cannot be posted to',
        [{ field: 'webhookUrl', message: egressRefusalMessage(verdict.reason) }],
        `channel_egress_${verdict.reason}`,
      );
    }
  }

  private notFound(code = 'channel_link_not_found'): ApiError {
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, code);
  }
}
