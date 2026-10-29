import { createHmac } from 'node:crypto';
import { ApiError } from '../../common/http/errors.js';

/**
 * 55-21 usability measurement — the event registry and the pure checks every event passes before
 * a row exists (`55-EASIEST-TO-USE-PROGRAM` §55-21, `34-ANALYTICS` §2–§3).
 *
 * ## Allowlist, never a blocklist
 *
 * An event name the registry does not know is dropped. A property key the event does not declare
 * is dropped — `message_text`, `email`, `file_name` and every other way content could ride along
 * included (PRIV-06). A declared key whose value is off its vocabulary is dropped too, so a value
 * is only ever an enum member, a boolean, a time bucket, a short lower-case slug or a small count.
 * Nothing the client sends can name the organization, the person or the time beyond ±5 minutes:
 * the organization and the actor come from the verified session, and the instant is clamped.
 */

/** Requests per hour one session may send (plan: 120 req/h/session). */
export const EVENTS_PER_HOUR_PER_SESSION = 120;
/** Events in one batch (plan: ≤ 50/req). */
export const MAX_EVENTS_PER_BATCH = 50;
/** The whole body, serialised (characters). Far above 50 well-formed events; far below anything abusive. */
export const MAX_BODY_CHARS = 32 * 1024;
/** How far a client clock may differ from the server's before the instant is pinned. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Rows with fewer events than this are withheld from any aggregate (k-anonymity floor). */
export const K_ANONYMITY_FLOOR = 5;

/** Time buckets for every timer property. A raw number of seconds is never stored. */
export const TIME_BUCKETS = [
  'lt_10s',
  '10_30s',
  '30_60s',
  '1_3m',
  '3_10m',
  '10_30m',
  '30_60m',
  '1_24h',
  'gt_24h',
] as const;

export const PRODUCT_EVENT_PLATFORMS = ['web', 'phone_web', 'desktop'] as const;
export type ProductEventPlatform = (typeof PRODUCT_EVENT_PLATFORMS)[number];
export type ProductEventPrincipalKind = 'internal' | 'client';

type PropertyRule =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'slug' }
  | { readonly kind: 'bucket' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'count' };

const slug = { kind: 'slug' } as const;
const bucket = { kind: 'bucket' } as const;
const locale = { kind: 'enum', values: ['en', 'ar'] } as const;
const uiMode = { kind: 'enum', values: ['simple', 'power'] } as const;

/** Every event 55-21 adds to `34-ANALYTICS` §3, with the only properties each may carry. */
export const PRODUCT_EVENT_REGISTRY: Readonly<
  Record<string, Readonly<Record<string, PropertyRule>>>
> = Object.freeze({
  onboarding_step_completed_v1: { step: slug, seconds_bucket: bucket },
  onboarding_completed_v1: {},
  first_project_created_v1: { seconds_since_signup_bucket: bucket },
  ui_mode_changed_v1: { from: uiMode, to: uiMode, source: slug },
  palette_used_v1: { section: slug, locale },
  quick_add_parsed_v1: { chips_recognised: { kind: 'count' } },
  tour_step_viewed_v1: { tour: slug, step: slug },
  checklist_item_completed_v1: { item: slug, source: slug },
  help_article_viewed_v1: { article_key: slug, from_screen: slug },
  help_feedback_v1: { article_key: slug, helpful: { kind: 'boolean' } },
  support_conversation_opened_v1: {
    audience: { kind: 'enum', values: ['internal', 'client'] },
    locale,
  },
  portal_action_found_v1: { seconds_bucket: bucket },
  approval_decided_v1: {
    decision: { kind: 'enum', values: ['approved', 'changes_requested', 'rejected'] },
  },
  empty_state_action_v1: { screen: slug },
  magic_link_consumed_v1: { purpose: slug },
});

/** Events whose bucket the scoreboard reads as a timer. */
export const TIMER_EVENTS: readonly string[] = [
  'onboarding_step_completed_v1',
  'first_project_created_v1',
  'portal_action_found_v1',
];

const SLUG = /^[a-z][a-z0-9_.-]{0,47}$/;
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

/** One event as the API will store it. */
export interface AcceptedProductEvent {
  readonly eventName: string;
  readonly eventVersion: number;
  readonly occurredAt: Date;
  readonly locale: string | null;
  readonly platform: ProductEventPlatform;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

export interface ParsedBatch {
  readonly accepted: readonly AcceptedProductEvent[];
  /** Events dropped whole (unknown name, not an object). */
  readonly droppedEvents: number;
  /** Property keys dropped from accepted events (unknown key or off-vocabulary value). */
  readonly droppedProperties: number;
}

function validValue(rule: PropertyRule, value: unknown): value is string | number | boolean {
  switch (rule.kind) {
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value);
    case 'slug':
      return typeof value === 'string' && SLUG.test(value);
    case 'bucket':
      return typeof value === 'string' && (TIME_BUCKETS as readonly string[]).includes(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'count':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 50;
  }
}

/** The client's instant pinned to ±{@link CLOCK_SKEW_MS} of `now`; missing or junk is `now`. */
export function clampOccurredAt(raw: unknown, now: Date): Date {
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return now;
  const at = now.getTime();
  return new Date(Math.min(at + CLOCK_SKEW_MS, Math.max(at - CLOCK_SKEW_MS, parsed)));
}

/**
 * Validate a `{ events: [...] }` body. The envelope's shape is the client's error (400, or 413
 * over the size cap); what is inside an event is filtered silently, because an older client
 * sending a retired property must not lose the whole batch.
 */
export function parseEventBatch(body: unknown, now: Date): ParsedBatch {
  if (JSON.stringify(body ?? null).length > MAX_BODY_CHARS) {
    throw new ApiError(413, 'validation_failed', 'Too much event data in one request.', [
      { field: 'events', message: `at most ${MAX_BODY_CHARS} characters` },
    ]);
  }
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_BATCH) {
    throw new ApiError(400, 'validation_failed', 'The events are invalid', [
      { field: 'events', message: `an array of 1–${MAX_EVENTS_PER_BATCH} events` },
    ]);
  }

  const accepted: AcceptedProductEvent[] = [];
  let droppedEvents = 0;
  let droppedProperties = 0;
  for (const raw of events) {
    const event = (typeof raw === 'object' && raw !== null ? raw : null) as Record<
      string,
      unknown
    > | null;
    const name = event?.['name'];
    const rules =
      typeof name === 'string' && Object.hasOwn(PRODUCT_EVENT_REGISTRY, name)
        ? PRODUCT_EVENT_REGISTRY[name]
        : undefined;
    if (!event || !rules) {
      droppedEvents += 1;
      continue;
    }
    const properties: Record<string, string | number | boolean> = {};
    const given = event['properties'];
    if (typeof given === 'object' && given !== null && !Array.isArray(given)) {
      for (const [key, value] of Object.entries(given)) {
        const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
        if (rule && validValue(rule, value)) properties[key] = value;
        else droppedProperties += 1;
      }
    }
    const rawLocale = event['locale'];
    const rawPlatform = event['platform'];
    accepted.push({
      eventName: name as string,
      eventVersion: 1,
      occurredAt: clampOccurredAt(event['occurredAt'], now),
      locale: typeof rawLocale === 'string' && LOCALE.test(rawLocale) ? rawLocale : null,
      platform: (PRODUCT_EVENT_PLATFORMS as readonly unknown[]).includes(rawPlatform)
        ? (rawPlatform as ProductEventPlatform)
        : 'web',
      properties,
    });
  }
  return { accepted, droppedEvents, droppedProperties };
}

/** `2026Q4` — the salt period, so one person's hash changes every quarter. */
export function saltPeriod(now: Date): string {
  return `${now.getUTCFullYear()}Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

/** HMAC-SHA256 of the membership id under the server salt and the quarter. 64 hex characters. */
export function hashActor(salt: string, membershipId: string, now: Date): string {
  return createHmac('sha256', salt)
    .update(`${saltPeriod(now)}|${membershipId}`)
    .digest('hex');
}
