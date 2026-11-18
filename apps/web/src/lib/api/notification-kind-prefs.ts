import type { ApiClient } from './client';

/**
 * The per-kind notification opt-out endpoints (x152) — the finer sibling of the coarse
 * notification-preferences surface.
 *
 * Behind `work.read` on the API and taking no membership id: a setting is always the acting member's
 * own. The GET lists every notification kind with the member's choice, unset kinds defaulted to
 * enabled; the PUT sets one kind and returns the whole set, so the screen re-renders every toggle
 * from one response. Since CQ-12 the relay honours a disabled kind at delivery for the notices it
 * writes (mentions, comments).
 */

/** The person-facing notification families a member can opt out of. Must match the API's enum. */
export type NotificationKind =
  | 'client_request'
  | 'work_item'
  | 'message'
  | 'file'
  | 'mention'
  // EMAILBUILD2 (0373): "Tips from the TManage team".
  | 'tips';

/** The kinds of the notification matrix: every kind except the tips preference (its own card). */
export type MatrixNotificationKind = Exclude<NotificationKind, 'tips'>;

/**
 * The caller's per-kind settings, every kind present. Each item is inlined rather than a second
 * exported shape, so the API↔web pairing is the one `NotificationKindPrefView` projection.
 */
export interface NotificationKindPrefView {
  readonly kinds: readonly {
    readonly kind: NotificationKind;
    readonly enabled: boolean;
    /** 55-18 (R18-d): how this kind reaches the member under the org profile. */
    readonly delivery: 'immediate' | 'digest';
  }[];
}

/** The body of a set-a-kind request. `Input` suffix marks it request-side, not a response shape. */
export interface SetNotificationKindInput {
  readonly enabled: boolean;
}

export async function getNotificationKindPrefs(
  client: ApiClient,
  organizationSlug: string,
): Promise<NotificationKindPrefView> {
  const { data } = await client.request<NotificationKindPrefView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/notification-preferences/kinds`,
  });
  return data;
}

export async function setNotificationKindPref(
  client: ApiClient,
  organizationSlug: string,
  kind: NotificationKind,
  input: SetNotificationKindInput,
): Promise<NotificationKindPrefView> {
  const { data } = await client.request<NotificationKindPrefView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/notification-preferences/kinds/${encodeURIComponent(kind)}`,
    body: input,
  });
  return data;
}
