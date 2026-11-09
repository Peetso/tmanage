import {
  CHANNEL_TEST_KIND,
  encodeChannelBot,
  isChannelBotSecret,
  isChannelLocale,
  parseChannelBot,
  renderChannelNotice,
} from '@tmanage/domain';
import type { ChannelNoticeEvent } from '@tmanage/domain';
import { microsoftAppFrom, postThroughBot } from './channel-bot-post.js';
import type { BotFetch, MicrosoftApp } from './channel-bot-post.js';
import {
  createFieldCipher,
  loadFieldCipherKeyring,
  type FieldCipher,
} from '@tmanage/domain/field-cipher';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import {
  checkEgress,
  excerptOf,
  nodePoster,
  webhookOwnHosts,
} from '../consumers/webhook-deliveries.js';
import type { WebhookPoster, WebhookResolver } from '../consumers/webhook-deliveries.js';
import { createChannelPostStore } from '../common/database/channel-post-store.js';
import type { BreakerDecision, WebhookAttemptStatus } from './webhook-retry-sweeper.js';

/**
 * R15-c (54-05 Slack + 54-06 Teams, Phase 0) — the channel post sweep.
 *
 * `consumers/channel-notices.ts` stages rows in `integration_channel_posts`; this is the only
 * sender. Each pass takes due `staged` rows, **one per link at a time** (4 lanes, 100 per pass), and
 * for each: claims it (`staged` → `sending`, state-conditioned), re-reads the link (paused or gone →
 * `cancelled`), decrypts the URL (FieldCipher `integration_token`, AAD = link id), **resolves the
 * host again and pins the connection** (`checkEgress`: private / loopback / metadata / own host →
 * `blocked_private_ip`), renders the EN/AR body (`renderChannelNotice`) and POSTs JSON with no
 * redirect following, a 10 s timeout and a 1 MiB read cap (`nodePoster`).
 *
 * After the attempt the webhook rules apply unchanged (`decideAfterAttempt`): backoff
 * `WEBHOOK_RETRY_BACKOFF_MS` (the row is retried in place, `attempt` + 1), the link's breaker
 * pauses it at `WEBHOOK_BREAKER_THRESHOLD` consecutive failures or on a 410 Gone. The ledger keeps
 * the status code and a short error class — never the body, never the URL.
 */

export const CHANNEL_SWEEP_INTERVAL_MS = 10_000;
export const CHANNEL_PASS_CONCURRENCY = 4;
export const CHANNEL_PASS_LIMIT = 100;
/** A `sending` row older than this died with its process. */
export const CHANNEL_STALE_SENDING_MS = 2 * 60_000;

export interface DuePost {
  readonly id: string;
  readonly linkId: string;
  readonly outboxEventId: string | null;
  readonly eventKind: string;
  readonly locale: string;
  readonly attempt: number;
}

export interface LinkForPost {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly webhookUrlEnc: string;
}

export interface PostOutcome {
  readonly status: WebhookAttemptStatus;
  readonly responseCode: number | null;
  readonly error: string | null;
}

/** What one settled attempt does to the ledger row and the link. */
export interface PostSettlement {
  readonly postStatus: 'delivered' | 'staged' | 'failed' | 'cancelled';
  readonly nextAttemptAt: Date | null;
  readonly pause: 'gone_410' | 'breaker_20_failures' | null;
}

/** Pure: the ledger row's next state from the breaker decision. */
export function settle(outcome: PostOutcome, decision: BreakerDecision, now: Date): PostSettlement {
  if (outcome.status === 'success')
    return { postStatus: 'delivered', nextAttemptAt: null, pause: null };
  if (outcome.status === 'cancelled')
    return { postStatus: 'cancelled', nextAttemptAt: null, pause: null };
  if (decision.kind === 'retry') {
    return {
      postStatus: 'staged',
      nextAttemptAt: new Date(now.getTime() + decision.delayMs),
      pause: null,
    };
  }
  return {
    postStatus: 'failed',
    nextAttemptAt: null,
    pause: decision.kind === 'pause' ? decision.reason : null,
  };
}

export interface ChannelPostStore {
  listDueOrganizations(now: Date): Promise<readonly string[]>;
  reopenStale(organizationId: string, before: Date): Promise<void>;
  listDue(organizationId: string, now: Date, limit: number): Promise<readonly DuePost[]>;
  claim(organizationId: string, id: string, now: Date): Promise<boolean>;
  loadLink(organizationId: string, linkId: string): Promise<LinkForPost | null>;
  loadEvent(organizationId: string, eventId: string): Promise<{ readonly payload: unknown } | null>;
  orgSlug(organizationId: string): Promise<string | null>;
  /** FIX5: write a bot link's refreshed (encrypted) descriptor back. */
  saveLinkSecret(organizationId: string, linkId: string, secretEnc: string): Promise<void>;
  /** Settle the row and the link's breaker in one transaction; returns what was decided. */
  finish(
    organizationId: string,
    post: DuePost,
    outcome: PostOutcome,
    now: Date,
  ): Promise<PostSettlement>;
}

export interface ChannelPostDeps {
  readonly store: ChannelPostStore;
  readonly cipher: FieldCipher;
  readonly ownHosts: readonly string[];
  /** The web app's public origin, for deep links; null → notices carry no link. */
  readonly webBaseUrl: string | null;
  readonly resolve?: WebhookResolver;
  readonly post?: WebhookPoster;
  readonly now?: () => Date;
  /** FIX5: the Microsoft app, for refreshing a Teams bot link's token; null when not set up. */
  readonly microsoft?: MicrosoftApp | null;
  /** FIX5: test seam for the bot posts (Slack / Graph). */
  readonly botFetch?: BotFetch;
}

function stateOf(payload: Record<string, unknown>): string | null {
  for (const key of ['toState', 'state', 'decision', 'toStatus']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** The deep link back into the web app for one event. */
export function deepLinkFor(
  base: string | null,
  slug: string | null,
  payload: Record<string, unknown>,
): string | null {
  if (base === null || slug === null) return null;
  const id = (key: string) => {
    const value = payload[key];
    return typeof value === 'string' && /^[0-9a-zA-Z-]{1,64}$/u.test(value) ? value : null;
  };
  const root = `${base.replace(/\/+$/u, '')}/${encodeURIComponent(slug)}`;
  if (id('workItemId')) return `${root}/work/${id('workItemId') as string}`;
  if (id('meetingId')) return `${root}/calendar/meetings/${id('meetingId') as string}`;
  if (id('projectId')) return `${root}/projects/${id('projectId') as string}`;
  return `${root}/home`;
}

async function attemptOutcome(
  deps: ChannelPostDeps,
  organizationId: string,
  post: DuePost,
): Promise<PostOutcome> {
  const link = await deps.store.loadLink(organizationId, post.linkId);
  if (link === null || link.status !== 'active') {
    return { status: 'cancelled', responseCode: null, error: 'link_not_active' };
  }
  let url: string;
  try {
    url = deps.cipher.decrypt(link.webhookUrlEnc, {
      purpose: 'integration_token',
      ownerId: link.id,
    });
  } catch {
    return { status: 'failed_permanent', responseCode: null, error: 'url_unreadable' };
  }
  let payload: Record<string, unknown> = {};
  if (post.outboxEventId !== null) {
    const event = await deps.store.loadEvent(organizationId, post.outboxEventId);
    if (event === null)
      return { status: 'failed_permanent', responseCode: null, error: 'event_missing' };
    if (event.payload !== null && typeof event.payload === 'object') {
      payload = event.payload as Record<string, unknown>;
    }
  }
  const notice: ChannelNoticeEvent = {
    kind: post.outboxEventId === null ? CHANNEL_TEST_KIND : post.eventKind,
    state: stateOf(payload),
    link: deepLinkFor(deps.webBaseUrl, await deps.store.orgSlug(organizationId), payload),
  };
  const rendered = renderChannelNotice(
    link.kind === 'teams' ? 'teams' : 'slack',
    notice,
    isChannelLocale(post.locale) ? post.locale : 'en',
  );

  // FIX5: a link made through one-click Connect posts through the provider's API as the bot.
  if (isChannelBotSecret(url)) {
    const descriptor = parseChannelBot(url);
    if (descriptor === null || descriptor.provider !== link.kind) {
      return { status: 'failed_permanent', responseCode: null, error: 'bot_unreadable' };
    }
    return postThroughBot(
      {
        fetch: deps.botFetch,
        microsoft: deps.microsoft ?? null,
        now: deps.now ? () => (deps.now as () => Date)().getTime() : undefined,
        saveDescriptor: (fresh) =>
          deps.store.saveLinkSecret(
            organizationId,
            link.id,
            deps.cipher.encrypt(encodeChannelBot(fresh), {
              purpose: 'integration_token',
              ownerId: link.id,
            }),
          ),
      },
      descriptor,
      rendered,
    );
  }

  const egress = await checkEgress(url, deps.ownHosts, deps.resolve);
  if (!egress.ok) return { status: egress.status, responseCode: null, error: egress.reason };
  const body = JSON.stringify(rendered);
  try {
    const answer = await (deps.post ?? nodePoster)(egress.url, egress.address, {}, body);
    const ok = answer.statusCode >= 200 && answer.statusCode < 300;
    return {
      status: ok ? 'success' : 'failure',
      responseCode: answer.statusCode >= 100 && answer.statusCode <= 599 ? answer.statusCode : null,
      error: ok ? null : excerptOf(answer.body),
    };
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      status: 'failure',
      responseCode: null,
      error: timedOut ? 'timeout' : 'connection_failed',
    };
  }
}

/** Deliver one claimed post and settle it. */
export async function deliverPost(
  deps: ChannelPostDeps,
  organizationId: string,
  post: DuePost,
): Promise<PostSettlement> {
  const outcome = await attemptOutcome(deps, organizationId, post);
  return deps.store.finish(organizationId, post, outcome, (deps.now ?? (() => new Date()))());
}

export interface ChannelPassReport {
  readonly delivered: number;
  readonly failed: number;
}

/** One pass: due posts per organization, one per link, four lanes, at most `limit` in all. */
export async function runChannelPostPass(
  deps: ChannelPostDeps,
  limit = CHANNEL_PASS_LIMIT,
): Promise<ChannelPassReport> {
  const clock = deps.now ?? (() => new Date());
  let delivered = 0;
  let failed = 0;
  let budget = limit;
  for (const organizationId of await deps.store.listDueOrganizations(clock())) {
    if (budget <= 0) break;
    const now = clock();
    await deps.store.reopenStale(
      organizationId,
      new Date(now.getTime() - CHANNEL_STALE_SENDING_MS),
    );
    const seen = new Set<string>();
    const batch = (await deps.store.listDue(organizationId, now, 500))
      .filter((post) => (seen.has(post.linkId) ? false : (seen.add(post.linkId), true)))
      .slice(0, budget);
    budget -= batch.length;
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < batch.length) {
        const post = batch[next] as DuePost;
        next += 1;
        if (!(await deps.store.claim(organizationId, post.id, clock()))) continue;
        const result = await deliverPost(deps, organizationId, post);
        if (result.postStatus === 'delivered') delivered += 1;
        else failed += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHANNEL_PASS_CONCURRENCY, batch.length) }, () => lane()),
    );
  }
  return { delivered, failed };
}

/** Loop mode: one pass now and one every {@link CHANNEL_SWEEP_INTERVAL_MS}; stops on `signal`. */
export async function runChannelPostSweepLoop(
  pass: () => Promise<ChannelPassReport>,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] channel post pass failed', error),
  intervalMs = CHANNEL_SWEEP_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await pass();
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}

/** The pass's dependencies from one worker pool and the env (standalone worker and `apps/server`). */
export function createChannelPostDeps(
  database: WorkerDatabase,
  env: {
    readonly API_PUBLIC_URL?: string | undefined;
    readonly WEB_PUBLIC_URL?: string | undefined;
    readonly FIELD_CIPHER_KEYS?: string | undefined;
    readonly MICROSOFT_CLIENT_ID?: string | undefined;
    readonly MICROSOFT_CLIENT_SECRET?: string | undefined;
    readonly MICROSOFT_TENANT?: string | undefined;
  },
): ChannelPostDeps {
  return {
    store: createChannelPostStore(database),
    cipher: createFieldCipher(loadFieldCipherKeyring(env)),
    ownHosts: webhookOwnHosts([env.API_PUBLIC_URL, env.WEB_PUBLIC_URL]),
    webBaseUrl: env.WEB_PUBLIC_URL ?? null,
    microsoft: microsoftAppFrom(env),
  };
}
