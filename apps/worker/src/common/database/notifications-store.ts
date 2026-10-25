import { uuidv7 } from '@tmanage/domain';
import type { PrincipalRole, QuietHoursPreferences } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';
import { CUSTOM_ROLE_COLUMNS, customRoleJoin, internalPrincipalRole } from './principal-role.js';
import type { CustomRoleColumns } from './principal-role.js';
import type { ClaimedOutboxEvent } from './outbox-store.js';

/**
 * The statements the notification consumers need — NOTIF-001.
 *
 * Everything here is scoped to the organization the triggering event carries, like the
 * lifecycle store beside it. The two read functions exist because of `24-EVENT-CATALOG`
 * §6: "Consumers cannot infer authorization from event receipt; before user-facing side
 * effects they resolve current permissions." A recipient is computed from the *current*
 * membership rows at delivery time, never from who could see the object when the event
 * was written — the difference is exactly a revocation that happened in between.
 */

/** An internal membership as the recipient decision needs to see it. */
export interface InternalRecipientCandidate {
  readonly userId: string;
  /** The resolved principal role (H1: a custom role carries its own set); null holds nothing. */
  readonly role: PrincipalRole | null;
  readonly hasOrgWideScope: boolean;
  /** Whether this user holds a project membership on the event's project. */
  readonly onProject: boolean;
}

/**
 * Every **active** internal membership, with the one relation fact the triage-recipient
 * rule reads. The role-to-capability half of the decision is the domain's
 * (`capabilitiesFor`), so it lives in the consumer rather than being restated as SQL.
 */
export async function listActiveInternalMemberships(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<readonly InternalRecipientCandidate[]> {
  interface Row extends CustomRoleColumns {
    readonly user_id: string;
    readonly role: string;
    readonly has_org_wide_scope: number;
    readonly on_project: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.user_id, m.role, ${CUSTOM_ROLE_COLUMNS}, m.has_org_wide_scope,
            EXISTS (
              SELECT 1 FROM project_memberships pm
               WHERE pm.organization_id = m.organization_id
                 AND pm.project_id = ?
                 AND pm.user_id = m.user_id
            ) AS on_project
       FROM memberships m
       ${customRoleJoin('m')}
      WHERE m.organization_id = ? AND m.status = 'active'`,
    [projectId, organizationId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    role: internalPrincipalRole(row.role, row),
    hasOrgWideScope: Boolean(row.has_org_wide_scope),
    onProject: Boolean(row.on_project),
  }));
}

/** An org-wide membership as the usage-threshold recipient decision needs to see it. */
export interface OrgWideMembershipCandidate {
  readonly userId: string;
  readonly role: string;
  readonly hasOrgWideScope: boolean;
}

/**
 * Every **active** membership of the organization, with its role and org-wide-scope flag —
 * USAGE-001 slice 4b. A usage threshold has no project, so this is the projectless sibling of
 * {@link listActiveInternalMemberships}: it returns the whole active set and leaves the
 * role/scope decision to the consumer's pure predicate, where `12-PERMISSION-MATRIX` §1's
 * "Billing/ownership" row (owner full, org admin policy) is transcribed and testable, rather
 * than being restated as SQL. Scoped to the one organization the event carries, like every
 * read here — recipients are resolved inside the tenant only (`24-EVENT-CATALOG` §6).
 */
export async function listActiveOrgWideMemberships(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<readonly OrgWideMembershipCandidate[]> {
  interface Row {
    readonly user_id: string;
    readonly role: string;
    readonly has_org_wide_scope: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.user_id, m.role, m.has_org_wide_scope
       FROM memberships m
      WHERE m.organization_id = ? AND m.status = 'active'`,
    [organizationId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    hasOrgWideScope: Boolean(row.has_org_wide_scope),
  }));
}

/**
 * The one user's **active** membership in the organization, in the same shape as
 * {@link listActiveOrgWideMemberships}, or `null` when they hold none now. A deferred usage mail
 * re-resolves its recipient through this at resume, so a person removed, suspended or demoted
 * during their quiet hours is not told (security audit F58, `24-EVENT-CATALOG` §6).
 */
export async function findActiveOrgWideMembership(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
): Promise<OrgWideMembershipCandidate | null> {
  interface Row {
    readonly user_id: string;
    readonly role: string;
    readonly has_org_wide_scope: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.user_id, m.role, m.has_org_wide_scope
       FROM memberships m
      WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
      LIMIT 1`,
    [organizationId, userId],
  );
  const row = rows[0];
  if (row === undefined || row.user_id !== userId) return null;
  return {
    userId: row.user_id,
    role: row.role,
    hasOrgWideScope: Boolean(row.has_org_wide_scope),
  };
}

/** Whether one user holds an active internal membership — a blocker owner's gate. */
export async function isActiveInternalMember(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.query<readonly { present: number }[]>(
    `SELECT EXISTS (
              SELECT 1 FROM memberships m
               WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
            ) AS present`,
    [organizationId, userId],
  );
  return Boolean(rows[0]?.present);
}

/** The person who filed a request — the transitioned notification's one recipient. */
export async function findRequestSubmitter(
  tx: WorkerTransaction,
  organizationId: string,
  requestId: string,
): Promise<string | null> {
  const rows = await tx.query<readonly { submitted_by_user_id: string }[]>(
    `SELECT submitted_by_user_id FROM client_requests
      WHERE organization_id = ? AND id = ?`,
    [organizationId, requestId],
  );
  return rows[0]?.submitted_by_user_id ?? null;
}

/**
 * §6's revocation check for a client recipient, all three parts current as of this
 * statement: an **active**, unexpired client membership in the client organization the
 * request belongs to, and the project still shared with that client organization. Any of
 * the three failing means the person is told nothing — a notification held back is
 * recoverable; one that reveals a revoked object is not.
 */
export async function clientRecipientStillPermitted(
  tx: WorkerTransaction,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly clientOrganizationId: string;
    readonly projectId: string;
  },
): Promise<boolean> {
  const rows = await tx.query<readonly { permitted: number }[]>(
    `SELECT EXISTS (
              SELECT 1 FROM client_memberships cm
               WHERE cm.organization_id = ?
                 AND cm.user_id = ?
                 AND cm.client_organization_id = ?
                 AND cm.status = 'active'
                 AND (cm.expires_at IS NULL OR cm.expires_at > NOW(3))
            )
        AND EXISTS (
              SELECT 1 FROM project_clients pc
               WHERE pc.organization_id = ?
                 AND pc.project_id = ?
                 AND pc.client_organization_id = ?
            ) AS permitted`,
    [
      input.organizationId,
      input.userId,
      input.clientOrganizationId,
      input.organizationId,
      input.projectId,
      input.clientOrganizationId,
    ],
  );
  return Boolean(rows[0]?.permitted);
}

/**
 * The recipient's quiet-hours window — INBOX-001. Read at delivery time, in the same
 * transaction the mail consumer reads its facts in, so the window honoured is the one in force
 * now. Absent row, or any of the three columns unset, reads as "no quiet hours" (the same
 * default the API returns), which {@link QuietHoursPreferences} carries as nulls.
 */
export async function findRecipientQuietHours(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
): Promise<QuietHoursPreferences | null> {
  interface Row {
    readonly quiet_hours_start: string | null;
    readonly quiet_hours_end: string | null;
    readonly quiet_hours_timezone: string | null;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT quiet_hours_start, quiet_hours_end, quiet_hours_timezone
       FROM notification_preferences
      WHERE organization_id = ? AND user_id = ?`,
    [organizationId, userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    quietHoursTimezone: row.quiet_hours_timezone,
  };
}

/**
 * What the usage-threshold mail needs about one recipient, resolved at delivery — USAGE-001
 * slice 4c. The address and name come from the global `users` row (re-read at delivery, never
 * carried on the event, `24-EVENT-CATALOG` §6 — an address changed since the crossing is the
 * one the owner reads); `emailEnabled` and the quiet-hours window come from this person's
 * `notification_preferences` row *in this organization* (NOTIF-001).
 */
export interface UsageMailRecipient {
  readonly email: string;
  readonly displayName: string;
  /** NOTIF-001's mail-channel toggle. Default TRUE when no preferences row exists — "reachable". */
  readonly emailEnabled: boolean;
  readonly quietHours: QuietHoursPreferences;
  /** `users.locale` (BCP-47, default 'en') — the language an email is written in (NT1). */
  readonly locale: string;
}

/**
 * One usage-mail recipient's address, name, mail-channel toggle and quiet-hours window, or null
 * when the user row is gone (silence, never a throw — the same answer the fan-out gives a
 * membership ended between the crossing and delivery).
 *
 * A `LEFT JOIN` because a person who has never opened the preferences screen has no row, and
 * `0022`'s defaults are then the honoured ones: reachable on email, no quiet hours. A `NULL`
 * `email_enabled` (no row) reads as TRUE — the "an account that opted into nothing is told
 * nothing" default the migration states — so a missing row and a saved default are one
 * behaviour. Scoped to the one organization the event carries, like every read here.
 */
export async function findUsageMailRecipient(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
): Promise<UsageMailRecipient | null> {
  interface Row {
    readonly email: string;
    readonly display_name: string;
    readonly locale?: string | null;
    readonly email_enabled: number | null;
    readonly quiet_hours_start: string | null;
    readonly quiet_hours_end: string | null;
    readonly quiet_hours_timezone: string | null;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT u.email, u.display_name, u.locale,
            np.email_enabled, np.quiet_hours_start, np.quiet_hours_end, np.quiet_hours_timezone
       FROM users u
       LEFT JOIN notification_preferences np
              ON np.organization_id = ? AND np.user_id = u.id
      WHERE u.id = ?`,
    [organizationId, userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    email: row.email,
    displayName: row.display_name,
    // No row (NULL) is the default-reachable state; a stored 0/1 is honoured.
    emailEnabled: row.email_enabled === null ? true : Boolean(row.email_enabled),
    quietHours: {
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      quietHoursTimezone: row.quiet_hours_timezone,
    },
    locale: row.locale ?? 'en',
  };
}

/**
 * The dedicated internal event type a quiet-hours-deferred interrupting delivery is re-enqueued
 * as — INBOX-001. When email would fire during a recipient's quiet window, the mail consumer
 * stages nothing and instead re-enqueues a row of *this* type (see {@link enqueueQuietHoursMailResume})
 * with `available_at` set to the window's end, so the relay claims it only once the window has
 * closed.
 *
 * It is a type of its own, not the original event type with a marker, so that only the one
 * consumer registered for it (the resume path in `client-request-mail.ts`) ever sees a resume
 * row. The original `client_request.*` types keep `both(notification, mail)`; a resume row is
 * routed to the resume handler alone, so the notification consumer — and any future
 * `client_request.*` consumer — cannot double-fire on it. That removes the implicit contract
 * that "every consumer of the real type is marker-aware or idempotent", which held only by
 * accident of who was registered.
 *
 * The name follows `24-EVENT-CATALOG`'s `domain.thing.vN` convention but is a worker-internal
 * delivery-mechanism type (like `CREDENTIAL_CHANGE_NOTICE_TYPE`), not one of §4's catalog
 * events, so it is not a member of the domain `OUTBOX_EVENT_CATALOG`: no producer outside this
 * file writes it and no consumer outside this worker reads it. The `outbox_events.type` column
 * is a free `VARCHAR`, so no allow-list gates the insert.
 *
 * The in-app notification is untouched by all this: it is written on the *original* delivery,
 * transactionally, so `35-NOTIFICATION-AND-EMAIL-COPY` §1's canonical channel arrives at once
 * and only the interrupting email waits.
 */
export const QUIET_HOURS_MAIL_RESUME_TYPE = 'notification.quiet_hours_resume.v1';

/**
 * The payload a {@link QUIET_HOURS_MAIL_RESUME_TYPE} row carries: the original event's type and
 * its (reference-only) payload, enough for the resume handler to recover the mail kind and the
 * request/project/client ids without re-reading the original row.
 */
export interface QuietHoursMailResumeEnvelope {
  readonly originalType: string;
  readonly originalPayload: Record<string, unknown>;
  /**
   * The one recipient this deferral is for, when the original delivery was a per-recipient
   * fan-out (USAGE-001's owner/admin usage mail). Absent for a single-recipient deferral (the
   * client-request mail), whose recipient is recovered from the original payload's ids. A
   * fan-out defers each in-quiet-hours recipient as its own resume row so the resume mails just
   * that one — re-running the whole fan-out on resume would re-mail the recipients who were not
   * in quiet hours and were already sent on the original pass.
   */
  readonly recipientUserId?: string;
}

/**
 * Read the envelope off a claimed resume row, or null when it is not a well-formed one. A
 * malformed resume row (no interrupting channel could have produced it) is dropped rather than
 * throwing, so it publishes to zero consumers like any other undeliverable row.
 */
export function decodeQuietHoursMailResume(
  event: ClaimedOutboxEvent,
): QuietHoursMailResumeEnvelope | null {
  if (event.payload === null || typeof event.payload !== 'object') return null;
  const envelope = event.payload as Record<string, unknown>;
  const originalType = envelope['originalType'];
  const originalPayload = envelope['originalPayload'];
  if (typeof originalType !== 'string') return null;
  if (originalPayload === null || typeof originalPayload !== 'object') return null;
  const recipientUserId = envelope['recipientUserId'];
  return {
    originalType,
    originalPayload: originalPayload as Record<string, unknown>,
    ...(typeof recipientUserId === 'string' ? { recipientUserId } : {}),
  };
}

/**
 * Re-enqueue an interrupting delivery so it fires when the recipient's quiet window ends —
 * INBOX-001. A {@link QUIET_HOURS_MAIL_RESUME_TYPE} row whose payload wraps the original event's
 * type and payload, `available_at = resumeAt`, scoped to the original's organization and pointing
 * at the same aggregate (so `ix_outbox_events_org_aggregate` still answers "everything about this
 * request"). The original event still publishes on this pass: its in-app notification is
 * committed and its interrupting send is the only thing held back.
 */
export async function enqueueQuietHoursMailResume(
  tx: WorkerTransaction,
  event: ClaimedOutboxEvent,
  resumeAt: Date,
  recipientUserId?: string,
): Promise<void> {
  const originalPayload =
    event.payload !== null && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  const resumePayload: QuietHoursMailResumeEnvelope = {
    originalType: event.type,
    originalPayload,
    ...(recipientUserId === undefined ? {} : { recipientUserId }),
  };
  await tx.query(
    `INSERT INTO outbox_events
       (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
        payload_json, correlation_id, occurred_at, available_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?)`,
    [
      uuidv7(),
      event.organizationId,
      QUIET_HOURS_MAIL_RESUME_TYPE,
      1,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(resumePayload),
      event.correlationId,
      resumeAt,
    ],
  );
}

export interface NotificationInput {
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly dedupeKey: string;
}

/**
 * Write one notification, idempotently. `uq_notifications_dedupe` absorbs the
 * at-least-once replay: `ON DUPLICATE KEY UPDATE id = id` turns the collision into a
 * no-op instead of an error, and the return value says which happened — an insert
 * reports one affected row, a collision zero.
 */
export async function insertNotification(
  tx: WorkerTransaction,
  input: NotificationInput,
): Promise<boolean> {
  const result = await tx.query<{ affectedRows: number }>(
    `INSERT INTO notifications
       (id, organization_id, recipient_user_id, type, object_type, object_id,
        dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE id = id`,
    [
      uuidv7(),
      input.organizationId,
      input.recipientUserId,
      input.type,
      input.objectType,
      input.objectId,
      input.dedupeKey,
    ],
  );
  return result.affectedRows === 1;
}
