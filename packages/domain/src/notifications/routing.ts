import { isRequiredActionKind, notificationDefaultsFor } from '../calendar/natural-defaults.js';
import type { NaturalNotificationKind, NotificationProfile } from '../calendar/natural-defaults.js';

/**
 * 53-15 — notification routing: every notification type the API and the worker write (the
 * `notifications.type` column) or mail, mapped to the preference **kind** a member controls and the
 * channels it can travel on, plus the member's per-kind × per-channel matrix.
 *
 * ## Why a catalog
 *
 * The per-kind opt-out stores five kinds (`notification_kind_prefs.kind`); the producers write some
 * forty types. Before this module only the collaboration notices that set an `optOutKind` honoured
 * the opt-out, so turning "Work" off silenced nothing a sweeper or a finance flow sent. Here every
 * type names its kind once, so a delivery path asks {@link routeFor} instead of hard-coding one,
 * and an unlisted type still lands in a kind by its prefix (never in "nowhere").
 *
 * ## The matrix
 *
 * Rows are the five kinds, columns In-app / Email / Digest (push waits for 53-15's VAPID keys).
 * In-app is the existing per-kind switch and stays the master: a kind turned off is neither written
 * to the inbox nor mailed nor digested. Email and Digest are stored per cell beside it. A company can
 * force e-mail on for a kind (`org_settings.notification_forced_email_kinds`): the member then sees
 * the in-app and e-mail cells locked on. Account and security notices (`account`) are not a row a
 * member can turn off: they always reach the inbox and the mailbox and are never batched.
 *
 * ## Digest parity
 *
 * Every member-facing type that can be e-mailed can also be batched into the digest (the digest reads
 * the inbox rows, so a digestable type must also be in-app). {@link digestParityGaps} lists any type
 * that breaks the rule; the unit suite keeps it empty.
 */

/** The matrix rows — mirrors `NOTIFICATION_KINDS` in the API schema (no migration adds one). */
export const MATRIX_KINDS: readonly NaturalNotificationKind[] = [
  'client_request',
  'work_item',
  'message',
  'file',
  'mention',
];

/** The matrix columns a member can set today. */
export const MATRIX_CHANNELS = ['in_app', 'email', 'digest'] as const;
export type MatrixChannel = (typeof MATRIX_CHANNELS)[number];

/** A route's group: a matrix kind, or the locked account & security group. */
export type RouteGroup = NaturalNotificationKind | 'account';

export interface NotificationRoute {
  readonly group: RouteGroup;
  /** Written to the recipient's inbox (`notifications` row). */
  readonly inApp: boolean;
  /** A mail template exists and the pipeline can send it immediately. */
  readonly email: boolean;
  /** Can be batched into the digest e-mail. */
  readonly digest: boolean;
  /** Security / account notice: ignores the matrix and quiet hours, never digested. */
  readonly critical: boolean;
  /** Reaches client people in the portal only (no member matrix applies). */
  readonly portalOnly: boolean;
}

function route(
  group: RouteGroup,
  channels: { readonly email?: boolean; readonly inApp?: boolean; readonly portalOnly?: boolean },
): NotificationRoute {
  const critical = group === 'account';
  const inApp = channels.inApp ?? true;
  const portalOnly = channels.portalOnly ?? false;
  return {
    group,
    inApp,
    email: channels.email ?? false,
    digest: inApp && !critical && !portalOnly,
    critical,
    portalOnly,
  };
}

const MAIL = { email: true } as const;
const IN_APP = {} as const;

/**
 * Every type a producer writes or mails today. Keys are the exact `notifications.type` (or outbox
 * event type for a mail-only notice). Grepped from `apps/worker/src` and `apps/api/src` (R35).
 */
export const NOTIFICATION_ROUTES: Readonly<Record<string, NotificationRoute>> = {
  // Client requests & approvals
  'client_request.submitted.v1': route('client_request', MAIL),
  'client_request.transitioned.v1': route('client_request', MAIL),
  'client_request.reopened.v1': route('client_request', IN_APP),
  'client_request.message_posted.v1': route('client_request', MAIL),
  'work_item.client_action_requested.v1': route('client_request', {
    email: true,
    inApp: false,
    portalOnly: true,
  }),
  'approval.requested.v1': route('client_request', MAIL),
  'approval.decided.v1': route('client_request', MAIL),
  'client_invoice.sent': route('client_request', IN_APP),
  // Work, deadlines, schedule, time and money
  'work_item.people_assigned.v1': route('work_item', MAIL),
  'work_item.supervised_done.v1': route('work_item', MAIL),
  'work_item.updated.v1': route('work_item', MAIL),
  'work_item.blocked.v1': route('work_item', IN_APP),
  'automation.notified.v1': route('work_item', IN_APP),
  'automation.test_run.v1': route('work_item', IN_APP),
  'recurrence.cap_reached': route('work_item', IN_APP),
  'recurrence.burst_capped': route('work_item', IN_APP),
  'recurrence.paused': route('work_item', IN_APP),
  'project.member_added.v1': route('work_item', MAIL),
  'meeting.attendee_invited.v1': route('work_item', MAIL),
  'meeting.changed.v1': route('work_item', MAIL),
  'timesheet.submitted': route('work_item', IN_APP),
  'timesheet.approved': route('work_item', IN_APP),
  'timesheet.changes_requested': route('work_item', IN_APP),
  'time_lock.unlock_requested': route('work_item', IN_APP),
  'expense.submitted': route('work_item', IN_APP),
  'expense.approved': route('work_item', IN_APP),
  'expense.rejected': route('work_item', IN_APP),
  'budget.threshold': route('work_item', IN_APP),
  'retainer.period_closed': route('work_item', IN_APP),
  // Messages & comments
  'message.created.v1': route('message', IN_APP),
  'direct_message.created.v1': route('message', IN_APP),
  'document.comment_created.v1': route('message', MAIL),
  // Files & reviews
  'review.comment_added.v1': route('file', MAIL),
  'review.replied.v1': route('file', MAIL),
  'review.thread_resolved.v1': route('file', IN_APP),
  'review.thread_reopened.v1': route('file', IN_APP),
  'review.approved.v1': route('file', MAIL),
  'review.changes_requested.v1': route('file', MAIL),
  // Mentions
  'message.mentioned.v1': route('mention', MAIL),
  'document.mentioned.v1': route('mention', MAIL),
  'review.mentioned.v1': route('mention', MAIL),
  // Account, billing & security — locked on
  'usage.threshold_reached.v1': route('account', MAIL),
  'webhook.endpoint_paused': route('account', IN_APP),
  'credential_change.notice.v1': route('account', { email: true, inApp: false }),
  'privacy_export.ready.v1': route('account', { email: true, inApp: false }),
  'privacy_deletion.changed.v1': route('account', { email: true, inApp: false }),
  // The digest's own claim row ("your summary was e-mailed") — never summarised itself.
  'notification.digest_sent': route('account', IN_APP),
};

/** The group a type outside the catalog falls into, by its first dotted segment. */
const PREFIX_GROUPS: Readonly<Record<string, RouteGroup>> = {
  client_request: 'client_request',
  approval: 'client_request',
  client_invoice: 'client_request',
  work_item: 'work_item',
  automation: 'work_item',
  recurrence: 'work_item',
  project: 'work_item',
  meeting: 'work_item',
  timesheet: 'work_item',
  time_lock: 'work_item',
  expense: 'work_item',
  budget: 'work_item',
  retainer: 'work_item',
  message: 'message',
  direct_message: 'message',
  document: 'message',
  review: 'file',
  file: 'file',
  usage: 'account',
  webhook: 'account',
  credential_change: 'account',
  privacy_export: 'account',
  privacy_deletion: 'account',
  security: 'account',
};

/** The route for a type: the catalog entry, else its prefix group (in-app only), else work. */
export function routeFor(type: string): NotificationRoute {
  const known = NOTIFICATION_ROUTES[type];
  if (known !== undefined) return known;
  if (/\.mentioned(?:\.v\d+)?$/u.test(type)) return route('mention', IN_APP);
  const prefix = type.split('.')[0] ?? '';
  return route(PREFIX_GROUPS[prefix] ?? 'work_item', IN_APP);
}

/** The matrix kind a type is controlled by, or null for a locked account notice. */
export function matrixKindOf(type: string): NaturalNotificationKind | null {
  const group = routeFor(type).group;
  return group === 'account' ? null : group;
}

/** Every catalogued type in a group — what the screen counts under each row. */
export function typesInGroup(group: RouteGroup): readonly string[] {
  return Object.entries(NOTIFICATION_ROUTES)
    .filter(([, value]) => value.group === group)
    .map(([type]) => type);
}

/** Whether any member-facing type in the kind can be e-mailed / digested at all. */
export function kindChannelAvailable(
  kind: NaturalNotificationKind,
  channel: MatrixChannel,
): boolean {
  const routes = Object.values(NOTIFICATION_ROUTES).filter(
    (value) => value.group === kind && !value.portalOnly,
  );
  if (channel === 'in_app') return routes.some((value) => value.inApp);
  if (channel === 'email') return routes.some((value) => value.email);
  return routes.some((value) => value.digest);
}

/**
 * Digest parity: member-facing types that can be e-mailed but not digested, or digested without an
 * inbox row to batch. Empty when the catalog is sound.
 */
export function digestParityGaps(
  routes: Readonly<Record<string, NotificationRoute>> = NOTIFICATION_ROUTES,
): readonly string[] {
  return Object.entries(routes)
    .filter(([, value]) => !value.critical && !value.portalOnly)
    .filter(([, value]) => (value.email && !value.digest) || (value.digest && !value.inApp))
    .map(([type]) => type);
}

/** One matrix cell set. */
export interface NotificationMatrixCell {
  readonly inApp: boolean;
  readonly email: boolean;
  readonly digest: boolean;
}

export type NotificationMatrix = Readonly<Record<NaturalNotificationKind, NotificationMatrixCell>>;

/**
 * The defaults a member with nothing saved starts from, under the org profile: an action-required
 * kind is in-app + e-mail; an informational one is in-app + digest under `calm` and in-app + e-mail
 * under `standard`. In-app is always on.
 */
export function defaultMatrixCell(
  profile: NotificationProfile,
  kind: NaturalNotificationKind,
): NotificationMatrixCell {
  if (isRequiredActionKind(kind)) return { inApp: true, email: true, digest: false };
  const digested = notificationDefaultsFor(profile).digestKinds.includes(kind);
  return { inApp: true, email: !digested, digest: digested };
}

/** The stored per-cell overrides (`user_preferences.prefs_json.notificationMatrix`). */
export type StoredMatrix = Partial<
  Record<NaturalNotificationKind, { readonly email?: boolean; readonly digest?: boolean }>
>;

/** Read a stored blob defensively: unknown kinds and non-boolean values are dropped. */
export function parseStoredMatrix(raw: unknown): StoredMatrix {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<NaturalNotificationKind, { email?: boolean; digest?: boolean }>> = {};
  for (const kind of MATRIX_KINDS) {
    const cell = (value as Record<string, unknown>)[kind];
    if (cell === null || typeof cell !== 'object') continue;
    const entry: { email?: boolean; digest?: boolean } = {};
    const email = (cell as Record<string, unknown>)['email'];
    const digest = (cell as Record<string, unknown>)['digest'];
    if (typeof email === 'boolean') entry.email = email;
    if (typeof digest === 'boolean') entry.digest = digest;
    out[kind] = entry;
  }
  return out;
}

/** Parse the company's forced-e-mail csv into kinds, in matrix order. */
export function parseForcedEmailKinds(
  raw: string | null | undefined,
): readonly NaturalNotificationKind[] {
  const names = (raw ?? '').split(',').map((name) => name.trim().toLowerCase());
  return MATRIX_KINDS.filter((kind) => names.includes(kind));
}

/** One member's effective cell: defaults, then stored choices, then the company's forced e-mail. */
export function effectiveMatrixCell(input: {
  readonly profile: NotificationProfile;
  readonly kind: NaturalNotificationKind;
  /** The per-kind switch (`notification_kind_prefs.enabled`); undefined when never set. */
  readonly kindEnabled: boolean | undefined;
  readonly stored: StoredMatrix;
  readonly forcedEmail: boolean;
}): NotificationMatrixCell {
  const base = defaultMatrixCell(input.profile, input.kind);
  const saved = input.stored[input.kind] ?? {};
  const cell = {
    inApp: input.kindEnabled ?? base.inApp,
    email: saved.email ?? base.email,
    digest: saved.digest ?? base.digest,
  };
  return input.forcedEmail ? { ...cell, inApp: true, email: true } : cell;
}

/** What one delivery of `type` does for a recipient with `cell` (null: a client, no matrix). */
export interface DeliveryDecision {
  readonly inApp: boolean;
  readonly email: boolean;
}

export function decideDelivery(
  type: string,
  cell: NotificationMatrixCell | null,
): DeliveryDecision {
  const routeOf = routeFor(type);
  if (routeOf.critical || cell === null) return { inApp: true, email: true };
  if (!cell.inApp) return { inApp: false, email: false };
  return { inApp: true, email: cell.email };
}

/** Whether an inbox row of `type` belongs in a digest for a member with `cell`. */
export function belongsInDigest(type: string, cell: NotificationMatrixCell): boolean {
  const routeOf = routeFor(type);
  return routeOf.digest && cell.inApp && cell.digest;
}
