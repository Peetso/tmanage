import type { ApiClient } from './client';

/**
 * 55-21 usability measurement — the browser side of `POST /v1/organizations/:orgSlug/events`
 * (internal members) and `.../portal/events` (client principals).
 *
 * Metadata only. A screen calls {@link ProductEventQueue.emit} with an event name from the API's
 * registry and properties that are enums, booleans, time buckets, short lower-case slugs or small
 * counts — never text a person typed, a file name or an email. The server drops anything else, so
 * this type is a convenience, not the control. The organization and the person come from the
 * session on the server; nothing here names them.
 *
 * Fire-and-forget by design: measurement must never break or slow a screen, so a failed send is
 * swallowed and its events are lost (they are statistics, not records).
 */

export type ProductEventName =
  | 'onboarding_step_completed_v1'
  | 'onboarding_completed_v1'
  | 'first_project_created_v1'
  | 'ui_mode_changed_v1'
  | 'palette_used_v1'
  | 'quick_add_parsed_v1'
  | 'tour_step_viewed_v1'
  | 'checklist_item_completed_v1'
  | 'help_article_viewed_v1'
  | 'help_feedback_v1'
  | 'support_conversation_opened_v1'
  | 'portal_action_found_v1'
  | 'approval_decided_v1'
  | 'empty_state_action_v1'
  | 'magic_link_consumed_v1';

export type ProductEventPlatform = 'web' | 'phone_web' | 'desktop';

export interface ProductEventInput {
  readonly name: ProductEventName;
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
}

interface WireEvent extends ProductEventInput {
  readonly occurredAt: string;
  readonly locale?: string;
  readonly platform: ProductEventPlatform;
}

/** The server's batch ceiling. */
export const PRODUCT_EVENT_BATCH_MAX = 50;

/** Seconds → the server's time bucket. A raw duration is never sent. */
export function timeBucket(seconds: number): string {
  if (seconds < 10) return 'lt_10s';
  if (seconds < 30) return '10_30s';
  if (seconds < 60) return '30_60s';
  if (seconds < 180) return '1_3m';
  if (seconds < 600) return '3_10m';
  if (seconds < 1800) return '10_30m';
  if (seconds < 3600) return '30_60m';
  if (seconds < 86_400) return '1_24h';
  return 'gt_24h';
}

export interface ProductEventQueueOptions {
  readonly client: ApiClient;
  readonly organizationSlug: string;
  readonly audience: 'internal' | 'client';
  readonly locale?: string;
  readonly platform?: ProductEventPlatform;
  /** How long events wait to be batched. */
  readonly flushMs?: number;
  readonly now?: () => Date;
}

export interface ProductEventQueue {
  emit(event: ProductEventInput): void;
  /** Send what is queued now (call on route change or `pagehide`). */
  flush(): Promise<void>;
}

export function createProductEventQueue(options: ProductEventQueueOptions): ProductEventQueue {
  const pending: WireEvent[] = [];
  const now = options.now ?? (() => new Date());
  const suffix = options.audience === 'client' ? 'portal/events' : 'events';
  const path = `/v1/organizations/${encodeURIComponent(options.organizationSlug)}/${suffix}`;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    while (pending.length > 0) {
      const events = pending.splice(0, PRODUCT_EVENT_BATCH_MAX);
      try {
        await options.client.request({ method: 'POST', path, body: { events } });
      } catch {
        // Statistics, not records: a failed batch is dropped, never retried into a loop.
      }
    }
  };

  return {
    emit(event) {
      pending.push({
        ...event,
        occurredAt: now().toISOString(),
        platform: options.platform ?? 'web',
        ...(options.locale ? { locale: options.locale } : {}),
      });
      if (pending.length >= PRODUCT_EVENT_BATCH_MAX) void flush();
      else if (timer === null) timer = setTimeout(() => void flush(), options.flushMs ?? 3000);
    },
    flush,
  };
}
