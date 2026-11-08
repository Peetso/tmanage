import type { ApiClient } from './client';
import type { NotificationKind } from './notification-kind-prefs';

/**
 * 53-15 — the notification matrix: rows are the five kinds, columns In-app / E-mail / Digest.
 * Behind `work.read`, the acting member's own (no membership in the path). The In-app cell is the
 * per-kind switch the older endpoint sets; E-mail and Digest are stored beside it. A kind the
 * company forces keeps In-app and E-mail on (a PUT turning them off is a 409).
 */

export type NotificationMatrixChannel = 'in_app' | 'email' | 'digest';

/** The member's matrix. Paired with the API's `NotificationMatrixView`. */
export interface NotificationMatrixView {
  readonly profile: 'calm' | 'standard';
  readonly rows: readonly {
    readonly kind: NotificationKind;
    readonly inApp: boolean;
    readonly email: boolean;
    readonly digest: boolean;
    readonly forcedEmail: boolean;
    readonly defaults: {
      readonly inApp: boolean;
      readonly email: boolean;
      readonly digest: boolean;
    };
    readonly available: { readonly email: boolean; readonly digest: boolean };
    readonly delivery: 'immediate' | 'digest';
    readonly typeCount: number;
  }[];
  readonly account: { readonly typeCount: number };
  readonly forcedEmailKinds: readonly NotificationKind[];
  readonly canManageCompany: boolean;
}

/** One cell change. `Input` suffix marks it request-side. */
export interface SetNotificationMatrixCellInput {
  readonly kind: NotificationKind;
  readonly channel: NotificationMatrixChannel;
  readonly enabled: boolean;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/notification-matrix`;
}

export async function getNotificationMatrix(
  client: ApiClient,
  organizationSlug: string,
): Promise<NotificationMatrixView> {
  const { data } = await client.request<NotificationMatrixView>({ path: path(organizationSlug) });
  return data;
}

export async function setNotificationMatrixCell(
  client: ApiClient,
  organizationSlug: string,
  input: SetNotificationMatrixCellInput,
): Promise<NotificationMatrixView> {
  const { data } = await client.request<NotificationMatrixView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: input,
  });
  return data;
}

/** The org setting the company rule writes through the generic settings PUT (`org.manage`). */
export const FORCED_EMAIL_SETTING_KEY = 'notification_forced_email_kinds';

/** The stored csv for a set of forced kinds, in matrix order. */
export function forcedEmailValue(
  kinds: readonly NotificationKind[],
  order: readonly NotificationKind[],
): string {
  return order.filter((kind) => kinds.includes(kind)).join(',');
}
