import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import {
  createFieldCipher,
  loadFieldCipherKeyring,
  type FieldCipher,
} from '@tmanage/domain/field-cipher';
import {
  createWebhookDeliveryStore,
  listStagingEndpoints,
  stagePending,
} from '../common/database/webhook-delivery-store.js';
import type {
  AttemptSettlement,
  OpenAttempt,
  WebhookDeliveryStore,
} from '../common/database/webhook-delivery-store.js';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler, OutboxHandlers } from '../outbox/dispatcher.js';
import { isRefusedAddress } from './link-previews.js';
import { decideAfterAttempt } from '../jobs/webhook-retry-sweeper.js';
import type { WebhookAttemptStatus, WebhookPassReport } from '../jobs/webhook-retry-sweeper.js';

/**
 * R13 slice 2 (54-03 + 56-08) — outbound webhook delivery.
 *
 * ## Staging, inside the event's transaction
 *
 * {@link webhookStagingConsumer} answers every outbox type a webhook kind fires on. It reads the
 * organization's `active`, enabled endpoints, applies the event filter (kind ↔ source type, plus a
 * payload filter such as `work.completed` = `toState === 'done'`) and inserts one `pending` attempt
 * per matching endpoint and kind — one delivery row per attempt. Nothing leaves the process here:
 * the rows commit or roll back with the event, so a redelivered event cannot double-stage.
 *
 * ## Delivery, in the sweep (`jobs/webhook-retry-sweeper.ts`)
 *
 * {@link runWebhookDeliveryPass} takes due attempts, **at most one per endpoint at a time** (an
 * endpoint with an attempt in flight is skipped; a `sending` row older than two minutes is a
 * crashed delivery and is reopened), and for each:
 *
 * 1. claims it (`pending` → `sending`, atomically — a second process gets 0 rows);
 * 2. re-reads the endpoint (paused / disabled / no secret → `cancelled`) and the outbox event;
 * 3. decrypts the secret(s) (FieldCipher, purpose `webhook_secret`, AAD = endpoint id) and signs
 *    the canonical body — `X-TManage-Signature: v1=…` (+ the previous secret's during the 24 h
 *    overlap), `X-TManage-Timestamp`, `X-TManage-Delivery-Id`, `X-TManage-Event`, `X-TManage-Org`;
 * 4. **egress guard at delivery**: resolves the host now and refuses it (`blocked_private_ip`) if
 *    any answer is private / loopback / link-local / metadata / CGNAT (the link-preview BlockList),
 *    or if the host is TManage's own; then **pins** the connection to the vetted address;
 * 5. POSTs over https with no redirect following (a 3xx is a failure), a 10 s timeout and a 1 MB
 *    read cap, keeping a 500-char excerpt of the answer — never the request body, never a secret;
 * 6. settles the row and applies the sweeper's decision: retry on the backoff table, reset or bump
 *    the breaker, and at 20 consecutive failures or a 410 pause the endpoint and tell its
 *    organization's owners / org admins in the inbox.
 *
 * ## Mirrors of the API
 *
 * The worker cannot import `apps/api`. {@link WEBHOOK_SOURCES}, {@link canonicalJson} and
 * {@link signatureFor} mirror `automations/webhook-event-catalog.ts` and
 * `automations/webhook-signing.ts`; both unit suites pin the same table and the same signature test
 * vector, so drift fails a test.
 */

export const WEBHOOK_USER_AGENT = 'TManage-Webhooks/1.0';
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 1024 * 1024;
export const WEBHOOK_EXCERPT_CHARS = 500;
/** A `sending` row older than this is a delivery that died with its process. */
export const WEBHOOK_STALE_SENDING_MS = 2 * 60_000;
/** Deliveries in flight at once across endpoints (one per endpoint, always). */
export const WEBHOOK_PASS_CONCURRENCY = 4;
export const WEBHOOK_PASS_LIMIT = 100;

interface WebhookSource {
  readonly source: string;
  readonly fields: readonly string[];
  readonly filter?: { readonly field: string; readonly equals: string };
}

/** Mirror of the API's `WEBHOOK_EVENT_SOURCES` (see the module doc). */
export const WEBHOOK_SOURCES: Readonly<Record<string, WebhookSource>> = {
  'work.created': {
    source: 'work_item.created.v1',
    fields: ['workItemId', 'projectId', 'state'],
  },
  'work.updated': {
    source: 'work_item.updated.v1',
    fields: ['workItemId', 'projectId', 'fromState', 'toState', 'workItemVersion'],
  },
  'work.completed': {
    source: 'work_item.updated.v1',
    fields: ['workItemId', 'projectId', 'fromState', 'toState', 'workItemVersion'],
    filter: { field: 'toState', equals: 'done' },
  },
  'approval.decided': {
    source: 'approval.decided.v1',
    fields: ['approvalId', 'deliverableId', 'deliverableVersionId', 'projectId', 'decision'],
  },
  'document.published': {
    source: 'document.published.v1',
    fields: ['documentId', 'projectId'],
  },
  'client_request.created': {
    source: 'client_request.submitted.v1',
    fields: ['requestId', 'projectId', 'clientOrganizationId', 'state'],
  },
  'client_request.transitioned': {
    source: 'client_request.transitioned.v1',
    fields: ['requestId', 'projectId', 'clientOrganizationId', 'fromStatus', 'toStatus'],
  },
  'meeting.scheduled': {
    source: 'meeting.scheduled.v1',
    fields: ['meetingId', 'projectId'],
  },
};

/** Every outbox type some webhook kind fires on — the types the staging consumer answers. */
export const WEBHOOK_SOURCE_TYPES: readonly string[] = [
  ...new Set(Object.values(WEBHOOK_SOURCES).map((entry) => entry.source)),
];

/** The event filter: same source type and, when the kind has one, the payload field matches. */
export function eventFiresKind(kind: string, type: string, payload: unknown): boolean {
  const entry = WEBHOOK_SOURCES[kind];
  if (entry === undefined || entry.source !== type) return false;
  if (entry.filter === undefined) return true;
  if (payload === null || typeof payload !== 'object') return false;
  return (payload as Record<string, unknown>)[entry.filter.field] === entry.filter.equals;
}

/** A stored `events_json`, reduced to kinds the catalogue still knows. */
export function parseEvents(raw: unknown): readonly string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed.filter(
              (kind): kind is string => typeof kind === 'string' && kind in WEBHOOK_SOURCES,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

// ─── signing (mirror of automations/webhook-signing.ts) ──────────────────────────────────────

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) sorted[key] = canonicalValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function signatureFor(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex')}`;
}

export function signedHeaders(input: {
  readonly secret: string;
  readonly previousSecret: string | null;
  readonly timestamp: number;
  readonly body: string;
  readonly deliveryId: string;
  readonly eventKind: string;
  readonly organizationId: string;
}): Record<string, string> {
  const signatures = [signatureFor(input.secret, input.timestamp, input.body)];
  if (input.previousSecret !== null) {
    signatures.push(signatureFor(input.previousSecret, input.timestamp, input.body));
  }
  return {
    'X-TManage-Signature': signatures.join(','),
    'X-TManage-Timestamp': String(input.timestamp),
    'X-TManage-Delivery-Id': input.deliveryId,
    'X-TManage-Event': input.eventKind,
    'X-TManage-Org': input.organizationId,
  };
}

/** The body: the envelope around the kind's payload fields (ids and states only). */
export function webhookBody(input: {
  readonly eventId: string;
  readonly eventKind: string;
  readonly occurredAt: Date;
  readonly organizationId: string;
  readonly payload: unknown;
}): string {
  const fields = WEBHOOK_SOURCES[input.eventKind]?.fields ?? [];
  const source = (input.payload ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const field of fields) if (field in source) data[field] = source[field];
  return canonicalJson({
    id: input.eventId,
    type: input.eventKind,
    occurredAt: input.occurredAt,
    organizationId: input.organizationId,
    data,
  });
}

export function excerptOf(text: string): string | null {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat === '' ? null : [...flat].slice(0, WEBHOOK_EXCERPT_CHARS).join('');
}

// ─── egress ───────────────────────────────────────────────────────────────────────────────────

export type WebhookResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const systemResolver: WebhookResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export type EgressCheck =
  | { readonly ok: true; readonly url: URL; readonly address: string }
  | {
      readonly ok: false;
      readonly status: 'blocked_private_ip' | 'failure';
      readonly reason: string;
    };

function bareHost(host: string): string {
  return host
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase();
}

/**
 * Resolve the endpoint's host at delivery and vet every answer. Any refused answer refuses the
 * name (a round-robin cannot smuggle a private address through on a lucky pick); TManage's own
 * host is refused by name. Returns the address to pin.
 */
export async function checkEgress(
  raw: string,
  ownHosts: readonly string[],
  resolve: WebhookResolver = systemResolver,
): Promise<EgressCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 'failure', reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return { ok: false, status: 'failure', reason: 'invalid_url' };
  }
  const host = bareHost(url.hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, status: 'blocked_private_ip', reason: 'blocked_private_ip' };
  }
  if (
    ownHosts.map(bareHost).some((own) => own !== '' && (host === own || host.endsWith(`.${own}`)))
  ) {
    return { ok: false, status: 'blocked_private_ip', reason: 'blocked_own_host' };
  }
  if (isIP(host) !== 0) {
    return isRefusedAddress(host)
      ? { ok: false, status: 'blocked_private_ip', reason: 'blocked_private_ip' }
      : { ok: true, url, address: host };
  }
  let answers: readonly { readonly address: string; readonly family: number }[];
  try {
    answers = await resolve(host);
  } catch {
    return { ok: false, status: 'failure', reason: 'unresolvable' };
  }
  if (answers.length === 0) return { ok: false, status: 'failure', reason: 'unresolvable' };
  if (answers.some((answer) => isRefusedAddress(answer.address))) {
    return { ok: false, status: 'blocked_private_ip', reason: 'blocked_private_ip' };
  }
  return { ok: true, url, address: (answers[0] as { address: string }).address };
}

export interface PostResult {
  readonly statusCode: number;
  readonly body: string;
}

export type WebhookPoster = (
  url: URL,
  address: string,
  headers: Readonly<Record<string, string>>,
  body: string,
) => Promise<PostResult>;

/** One POST over https, connected to `address` only, no redirects, 10 s, 1 MB read at most. */
export const nodePoster: WebhookPoster = (url, address, headers, body) =>
  new Promise<PostResult>((resolvePromise, reject) => {
    const family = isIP(address);
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': WEBHOOK_USER_AGENT,
        },
        // Pinned: the socket goes to the vetted address whatever DNS says now. SNI and the
        // certificate check still use the URL's hostname.
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean }).all === true) {
            (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
              { address, family },
            ]);
          } else {
            callback(null, address, family);
          }
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () =>
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        response.on('data', (chunk: Buffer) => {
          const room = WEBHOOK_MAX_RESPONSE_BYTES - size;
          if (room <= 0) return;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (size >= WEBHOOK_MAX_RESPONSE_BYTES) {
            response.destroy();
            finish();
          }
        });
        response.on('end', finish);
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });

// ─── store (common/database/webhook-delivery-store.ts) ──────────────────────────────────────

export {
  WEBHOOK_PAUSED_NOTICE_TYPE,
  createWebhookDeliveryStore,
  isWebhookNoticeRecipient,
} from '../common/database/webhook-delivery-store.js';
export type {
  AttemptSettlement,
  EndpointForDelivery,
  EventForDelivery,
  OpenAttempt,
  WebhookDeliveryStore,
} from '../common/database/webhook-delivery-store.js';

// ─── staging consumer ─────────────────────────────────────────────────────────────────────────

/**
 * Stage one `pending` attempt per active endpoint and kind the event fires, inside the event's
 * savepoint. No egress here.
 */
export const webhookStagingConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const endpoints = await listStagingEndpoints(tx, event.organizationId);
  if (endpoints.length === 0) return;
  const now = new Date();
  for (const endpoint of endpoints) {
    for (const kind of parseEvents(endpoint.events_json)) {
      if (!eventFiresKind(kind, event.type, event.payload)) continue;
      await stagePending(tx, event.organizationId, {
        endpointId: endpoint.id,
        eventId: event.id,
        eventKind: kind,
        attempt: 1,
        at: now,
      });
    }
  }
};

/** The staging consumer composed after whatever already answers each source type. */
export function withWebhookStaging(handlers: OutboxHandlers): OutboxHandlers {
  const composed: Record<string, OutboxHandler> = { ...handlers };
  for (const type of WEBHOOK_SOURCE_TYPES) {
    const existing = handlers[type];
    composed[type] =
      existing === undefined
        ? webhookStagingConsumer
        : async (event, tx, effects) => {
            await existing(event, tx, effects);
            await webhookStagingConsumer(event, tx, effects);
          };
  }
  return composed;
}

// ─── delivery ─────────────────────────────────────────────────────────────────────────────────

export interface WebhookDeliveryDeps {
  readonly store: WebhookDeliveryStore;
  readonly cipher: FieldCipher;
  /** TManage's own hostnames (API, web) — never a target. */
  readonly ownHosts: readonly string[];
  readonly resolve?: WebhookResolver;
  readonly post?: WebhookPoster;
  readonly now?: () => Date;
}

function settlement(
  status: WebhookAttemptStatus,
  extra: Partial<AttemptSettlement> = {},
): AttemptSettlement {
  return {
    status,
    responseCode: null,
    durationMs: null,
    responseExcerpt: null,
    signatureKeyId: null,
    resolvedIp: null,
    ...extra,
  };
}

/** Deliver one claimed attempt and return what was recorded. */
export async function deliverAttempt(
  deps: WebhookDeliveryDeps,
  organizationId: string,
  attempt: OpenAttempt,
): Promise<AttemptSettlement> {
  const now = (deps.now ?? (() => new Date()))();
  const outcome = await attemptOutcome(deps, organizationId, attempt, now);
  await deps.store.finish(
    organizationId,
    attempt,
    outcome,
    (streakAfter) => decideAfterAttempt(outcome, attempt.attempt, streakAfter),
    now,
  );
  return outcome;
}

async function attemptOutcome(
  deps: WebhookDeliveryDeps,
  organizationId: string,
  attempt: OpenAttempt,
  now: Date,
): Promise<AttemptSettlement> {
  const endpoint = await deps.store.loadEndpoint(organizationId, attempt.endpointId);
  if (endpoint === null || !endpoint.enabled || endpoint.status !== 'active') {
    return settlement('cancelled', { responseExcerpt: 'endpoint_not_active' });
  }
  if (endpoint.secretEnc === null) {
    return settlement('cancelled', { responseExcerpt: 'needs_rotation' });
  }
  if (attempt.eventId === null || attempt.eventKind === null) {
    return settlement('failed_permanent', { responseExcerpt: 'no_event' });
  }
  const event = await deps.store.loadEvent(organizationId, attempt.eventId);
  if (event === null) return settlement('failed_permanent', { responseExcerpt: 'event_missing' });

  let secret: string;
  let previousSecret: string | null = null;
  try {
    const aad = { purpose: 'webhook_secret' as const, ownerId: endpoint.id };
    secret = deps.cipher.decrypt(endpoint.secretEnc, aad);
    if (
      endpoint.secretPrevEnc !== null &&
      endpoint.secretPrevExpiresAt !== null &&
      endpoint.secretPrevExpiresAt.getTime() > now.getTime()
    ) {
      previousSecret = deps.cipher.decrypt(endpoint.secretPrevEnc, aad);
    }
  } catch {
    return settlement('failed_permanent', { responseExcerpt: 'signing_unavailable' });
  }
  const keyId = endpoint.secretHash.slice(0, 8);

  const egress = await checkEgress(endpoint.url, deps.ownHosts, deps.resolve);
  if (!egress.ok) {
    return settlement(egress.status, { responseExcerpt: egress.reason, signatureKeyId: keyId });
  }

  const body = webhookBody({
    eventId: attempt.eventId,
    eventKind: attempt.eventKind,
    occurredAt: event.occurredAt,
    organizationId,
    payload: event.payload,
  });
  const headers = signedHeaders({
    secret,
    previousSecret,
    timestamp: Math.floor(now.getTime() / 1000),
    body,
    deliveryId: attempt.id,
    eventKind: attempt.eventKind,
    organizationId,
  });
  const started = Date.now();
  try {
    const answer = await (deps.post ?? nodePoster)(egress.url, egress.address, headers, body);
    const ok = answer.statusCode >= 200 && answer.statusCode < 300;
    return settlement(ok ? 'success' : 'failure', {
      responseCode: answer.statusCode >= 100 && answer.statusCode <= 599 ? answer.statusCode : null,
      durationMs: Date.now() - started,
      responseExcerpt: excerptOf(answer.body),
      signatureKeyId: keyId,
      resolvedIp: egress.address,
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return settlement('failure', {
      durationMs: Date.now() - started,
      responseExcerpt: timedOut ? 'timeout' : 'connection_failed',
      signatureKeyId: keyId,
      resolvedIp: egress.address,
    });
  }
}

/** Which open attempts to run now: one due `pending` row per endpoint with nothing in flight. */
export function pickDue(
  open: readonly OpenAttempt[],
  now: Date,
): { readonly due: readonly OpenAttempt[]; readonly stale: readonly OpenAttempt[] } {
  const busy = new Set<string>();
  const stale: OpenAttempt[] = [];
  for (const row of open) {
    if (row.status !== 'sending') continue;
    if (now.getTime() - row.attemptedAt.getTime() > WEBHOOK_STALE_SENDING_MS) stale.push(row);
    else busy.add(row.endpointId);
  }
  const due: OpenAttempt[] = [];
  const taken = new Set<string>();
  for (const row of open) {
    if (row.status !== 'pending' || row.nextAttemptAt.getTime() > now.getTime()) continue;
    if (busy.has(row.endpointId) || taken.has(row.endpointId)) continue;
    taken.add(row.endpointId);
    due.push(row);
  }
  return { due, stale };
}

/** One sweep pass over every organization with an active endpoint. */
export async function runWebhookDeliveryPass(
  deps: WebhookDeliveryDeps,
  limit = WEBHOOK_PASS_LIMIT,
): Promise<WebhookPassReport> {
  const clock = deps.now ?? (() => new Date());
  let delivered = 0;
  let failed = 0;
  let budget = limit;
  for (const organizationId of await deps.store.listActiveOrganizations()) {
    if (budget <= 0) break;
    const now = clock();
    const { due, stale } = pickDue(await deps.store.listOpenAttempts(organizationId, 500), now);
    for (const row of stale) await deps.store.reopen(organizationId, row.id);
    const batch = due.slice(0, budget);
    budget -= batch.length;
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < batch.length) {
        const row = batch[next] as OpenAttempt;
        next += 1;
        if (!(await deps.store.claim(organizationId, row.id, clock()))) continue;
        const result = await deliverAttempt(deps, organizationId, row);
        if (result.status === 'success') delivered += 1;
        else failed += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WEBHOOK_PASS_CONCURRENCY, batch.length) }, () => lane()),
    );
  }
  return { delivered, failed };
}

/** TManage's own hostnames from its public URLs; an unparsable URL contributes nothing. */
export function webhookOwnHosts(urls: readonly (string | undefined)[]): string[] {
  return urls.flatMap((raw) => {
    try {
      return raw === undefined ? [] : [new URL(raw).hostname];
    } catch {
      return [];
    }
  });
}

/**
 * R14-a — the delivery pass's dependencies from one worker pool and the env, so the single
 * Hostinger app (`apps/server`) delivers exactly as the standalone worker does. Keyless
 * (`FIELD_CIPHER_KEYS` unset), every attempt is cancelled as `needs_rotation`.
 */
export function createWebhookDeliveryDeps(
  database: WorkerDatabase,
  env: {
    readonly API_PUBLIC_URL?: string | undefined;
    readonly WEB_PUBLIC_URL?: string | undefined;
    readonly FIELD_CIPHER_KEYS?: string | undefined;
  },
): WebhookDeliveryDeps {
  return {
    store: createWebhookDeliveryStore(database),
    cipher: createFieldCipher(loadFieldCipherKeyring(env)),
    ownHosts: webhookOwnHosts([env.API_PUBLIC_URL, env.WEB_PUBLIC_URL]),
  };
}
