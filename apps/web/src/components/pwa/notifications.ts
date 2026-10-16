import type { InboxItem, InboxPage } from '../../lib/api/inbox';

/**
 * The local-notifications logic for module 22's desktop companion (slice 08).
 *
 * Deliberately pure and browser-API-light: the React components in this folder own the DOM
 * and the window lifecycle, while everything that can be decided without them — whether the
 * platform supports notifications, whether the user has opted in, and which inbox notices are
 * new enough to raise — lives here so it can be proven in jsdom without a real `Notification`.
 *
 * There is **no web-push and no VAPID**: push is a Needs-Peter item in the module map, so this
 * file only ever raises a *local* `Notification` for a notice the inbox read already returned.
 * It opens no endpoint and subscribes to no push service.
 */

/** The permission the browser reports, plus `unsupported` for a browser without the API. */
export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

/** The localStorage key the opt-in choice is mirrored under — per browser, never on the server. */
export const NOTIFICATION_OPT_IN_KEY = 'tmanage:notifications:opt-in';

/** True only in a browser that exposes the Notifications API. Guards every other call. */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * The current permission, as a four-state value. `unsupported` when the API is absent, so a
 * caller never has to branch on `typeof Notification` itself.
 */
export function readNotificationPermission(): NotificationPermissionState {
  if (!isNotificationSupported()) {
    return 'unsupported';
  }
  return window.Notification.permission as NotificationPermissionState;
}

/**
 * Ask the browser for permission. **Only ever called from an explicit user action** (a button
 * in Preferences) — never on mount, never automatically. A guarded no-op returning
 * `unsupported` when the API is absent, so the caller needs no `typeof` guard of its own.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported()) {
    return 'unsupported';
  }
  const result = await window.Notification.requestPermission();
  return result as NotificationPermissionState;
}

/** Read the stored opt-in intent. Defaults to `false`; a broken/blocked store reads as `false`. */
export function readOptInChoice(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(NOTIFICATION_OPT_IN_KEY) === 'true';
  } catch {
    // Private windows and blocked site data throw on access — treat as not opted in.
    return false;
  }
}

/** Persist the opt-in intent. Swallows a throwing/blocked store: the choice is best-effort. */
export function writeOptInChoice(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(NOTIFICATION_OPT_IN_KEY, enabled ? 'true' : 'false');
  } catch {
    // Non-fatal: the switch still reflects the in-memory state for this session.
  }
}

/** One local notification to raise, derived from an inbox item. */
export interface NotificationDraft {
  /** A stable per-notice key, also used as the `Notification` tag so the OS coalesces repeats. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/** The most notifications to raise from a single poll, so a long backlog never floods the OS. */
export const MAX_NOTICES_PER_POLL = 3;

/**
 * Pick the inbox notices worth raising a local notification for, given the keys already seen.
 *
 * Pure and side-effect-free: the caller owns the seen-set and the actual `new Notification(...)`.
 * The rules, all here so they can be proven without a browser:
 *
 * - only items with something unread (`unreadCount > 0`) — a fully read bundle is not news;
 * - deduped by a key built from the item's identity **and** its latest timestamp, so the same
 *   bundle raises again only when it genuinely changes, never on every poll;
 * - capped at {@link MAX_NOTICES_PER_POLL} to throttle a first load with a large backlog.
 */
export function selectInboxNotices(
  page: Pick<InboxPage, 'items'>,
  seen: ReadonlySet<string>,
): readonly NotificationDraft[] {
  const drafts: NotificationDraft[] = [];
  for (const item of page.items) {
    if (drafts.length >= MAX_NOTICES_PER_POLL) {
      break;
    }
    if (item.unreadCount <= 0) {
      continue;
    }
    const key = noticeKey(item);
    if (seen.has(key)) {
      continue;
    }
    drafts.push({ key, ...describeNotice(item) });
  }
  return drafts;
}

/** A stable key for an inbox item: identity plus the latest change, so a change is a new notice. */
function noticeKey(item: InboxItem): string {
  return `${item.objectType}:${item.objectId}:${item.latestAt}`;
}

/**
 * Every notice key on a page. The bridge folds these into its seen-set on a poll it will not
 * notify for (the window is visible, or the user has not opted in), so a later backgrounded
 * poll raises only what is genuinely new rather than the whole standing backlog.
 */
export function collectNoticeKeys(page: Pick<InboxPage, 'items'>): readonly string[] {
  return page.items.map(noticeKey);
}

/** The sentence a notice reads as. The usage notice carries numbers; a bundle carries a title. */
function describeNotice(item: InboxItem): { title: string; body: string } {
  if (item.objectType === 'organization_usage') {
    return {
      title: 'Storage update',
      body: `Your organization's storage is at ${item.band}%.`,
    };
  }
  const count = item.unreadCount;
  return {
    title: item.title,
    body: count === 1 ? '1 new update' : `${count} new updates`,
  };
}
