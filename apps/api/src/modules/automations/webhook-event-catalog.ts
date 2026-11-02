import { OUTBOX_EVENT_CATALOG } from '@tmanage/domain';
import type { OutboxEventType } from '@tmanage/domain';

/**
 * R13 slice 2 (54-03) — the outbound webhook event catalogue.
 *
 * A webhook kind is a public, stable name for one outbox event (sometimes narrowed by a filter on
 * its payload). It is built **from** the outbox catalogue: every `source` below must be a live
 * `OUTBOX_EVENT_CATALOG` key, which the unit suite asserts, so a renamed or retired event fails the
 * build here rather than silently never firing. Payloads are the outbox's — ids and states only, by
 * the producer's contract — so a webhook body never carries a title, a message or a comment.
 *
 * `GET /v1/public/webhook-events` serves {@link webhookEventCatalogue} to anyone (no auth): it is
 * documentation of the shapes, not data.
 *
 * The worker's delivery consumer (`apps/worker/src/consumers/webhook-deliveries.ts`) keeps a
 * mirror of {@link WEBHOOK_EVENT_SOURCES}: the worker cannot import the API. Both suites pin the
 * same table, so a change to one without the other fails a test.
 */

export interface WebhookEventSource {
  /** The outbox event type the kind fires on. */
  readonly source: OutboxEventType;
  /** Plain-English description for the public catalogue. */
  readonly description: string;
  /** The payload fields a receiver gets under `data` (ids and states only). */
  readonly fields: readonly string[];
  /** When set, the event fires the kind only when `payload[field] === equals`. */
  readonly filter?: { readonly field: string; readonly equals: string };
}

export const WEBHOOK_EVENT_SOURCES = {
  'work.created': {
    source: 'work_item.created.v1',
    description: 'A work item was created.',
    fields: ['workItemId', 'projectId', 'state'],
  },
  'work.updated': {
    source: 'work_item.updated.v1',
    description: 'A work item moved from one state to another.',
    fields: ['workItemId', 'projectId', 'fromState', 'toState', 'workItemVersion'],
  },
  'work.completed': {
    source: 'work_item.updated.v1',
    description: 'A work item reached done.',
    fields: ['workItemId', 'projectId', 'fromState', 'toState', 'workItemVersion'],
    filter: { field: 'toState', equals: 'done' },
  },
  'approval.decided': {
    source: 'approval.decided.v1',
    description: 'A client (or a staff reviewer) approved or asked for changes.',
    fields: ['approvalId', 'deliverableId', 'deliverableVersionId', 'projectId', 'decision'],
  },
  'document.published': {
    source: 'document.published.v1',
    description: 'A document was published.',
    fields: ['documentId', 'projectId'],
  },
  'client_request.created': {
    source: 'client_request.submitted.v1',
    description: 'A client submitted a request.',
    fields: ['requestId', 'projectId', 'clientOrganizationId', 'state'],
  },
  'client_request.transitioned': {
    source: 'client_request.transitioned.v1',
    description: 'A client request changed state.',
    fields: ['requestId', 'projectId', 'clientOrganizationId', 'fromStatus', 'toStatus'],
  },
  'meeting.scheduled': {
    source: 'meeting.scheduled.v1',
    description: 'A meeting was scheduled.',
    fields: ['meetingId', 'projectId'],
  },
} as const satisfies Record<string, WebhookEventSource>;

export type WebhookEventKind = keyof typeof WEBHOOK_EVENT_SOURCES;

export const WEBHOOK_EVENT_KINDS = Object.keys(
  WEBHOOK_EVENT_SOURCES,
) as readonly WebhookEventKind[];

export function isWebhookEventKind(value: unknown): value is WebhookEventKind {
  return typeof value === 'string' && Object.hasOwn(WEBHOOK_EVENT_SOURCES, value);
}

/** The outbox types any kind fires on — what a replay reads. */
export function outboxTypesFor(kinds: readonly WebhookEventKind[]): readonly OutboxEventType[] {
  return [...new Set(kinds.map((kind) => WEBHOOK_EVENT_SOURCES[kind].source))];
}

/**
 * Whether an outbox event fires `kind`: same source type and, when the kind has a filter, the
 * payload field matches. The event filter both the replay route and the worker apply.
 */
export function eventFiresKind(kind: WebhookEventKind, type: string, payload: unknown): boolean {
  const entry: WebhookEventSource = WEBHOOK_EVENT_SOURCES[kind];
  if (entry.source !== type) return false;
  if (entry.filter === undefined) return true;
  if (payload === null || typeof payload !== 'object') return false;
  return (payload as Record<string, unknown>)[entry.filter.field] === entry.filter.equals;
}

/** Parse a stored `events_json`, keeping only kinds that are still in the catalogue. */
export function parseEventsJson(raw: string | null | undefined): readonly WebhookEventKind[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter(isWebhookEventKind))];
}

export interface WebhookEventCatalogueEntry {
  readonly kind: WebhookEventKind;
  readonly description: string;
  readonly fields: readonly string[];
}

/** The public catalogue, plus the envelope and headers every delivery carries. */
export function webhookEventCatalogue(): {
  readonly events: readonly WebhookEventCatalogueEntry[];
  readonly envelope: readonly string[];
  readonly headers: readonly string[];
  readonly signature: string;
} {
  // Every source must be a live outbox type — `OUTBOX_EVENT_CATALOG` is read so the import is the
  // build-time link, and a stale source is dropped rather than advertised.
  const events = WEBHOOK_EVENT_KINDS.filter((kind) =>
    Object.hasOwn(OUTBOX_EVENT_CATALOG, WEBHOOK_EVENT_SOURCES[kind].source),
  ).map((kind) => ({
    kind,
    description: WEBHOOK_EVENT_SOURCES[kind].description,
    fields: WEBHOOK_EVENT_SOURCES[kind].fields,
  }));
  return {
    events,
    envelope: ['id', 'type', 'occurredAt', 'organizationId', 'data'],
    headers: [
      'X-TManage-Signature',
      'X-TManage-Timestamp',
      'X-TManage-Delivery-Id',
      'X-TManage-Event',
      'X-TManage-Org',
    ],
    signature:
      'v1=<hex HMAC-SHA256(secret, "<X-TManage-Timestamp>.<raw body>")>; during the 24 h after a ' +
      'rotation a second v1= value signed with the previous secret follows, comma-separated.',
  };
}
