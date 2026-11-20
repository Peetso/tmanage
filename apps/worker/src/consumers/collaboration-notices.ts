import {
  MATRIX_KINDS,
  decideDelivery,
  eventTypeBypassesQuietHours,
  hasCapability,
  isClientRole,
  isInQuietHours,
  matrixKindOf,
  quietHoursResumeAt,
} from '@tmanage/domain';
import type { Capability, DeliveryDecision, NaturalNotificationKind } from '@tmanage/domain';
import { findMemberMatrixCell } from '../common/database/notification-matrix-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { roleHolds } from '../common/database/principal-role.js';
import {
  clientRecipientStillPermitted,
  decodeQuietHoursMailResume,
  enqueueQuietHoursMailResume,
  findUsageMailRecipient,
  insertNotification,
  listActiveInternalMemberships,
} from '../common/database/notifications-store.js';
import {
  findClientRequestFacts,
  findConversationFacts,
  findDisplayName,
  findDocumentFacts,
  findInternalReach,
  findMeetingFacts,
  findMembershipDisplayName,
  findOrganizationFacts,
  findProjectName,
  findWorkItemFacts,
  isConversationMember,
  listProjectClientPeople,
  listWorkItemClientAudience,
  listWorkItemSupervisors,
} from '../common/database/collaboration-store.js';
import type { InternalReach } from '../common/database/collaboration-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { settleApprovalEmailSend } from '../common/database/approval-email-send-store.js';
import type {
  ApprovalEmailOutcome,
  ApprovalEmailSettler,
} from '../common/database/approval-email-send-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import type {
  CollaborationEmailFacts,
  CollaborationMailKind,
  CollaborationMailer,
} from '../notifications/collaboration-mailer.js';

/**
 * CQ-12 — "people are never told anything" (COL-05, APR-03). The consumers for the five events
 * that now say something happened to a person:
 *
 * | Event                                  | Who is told                         | In-app | Email |
 * |----------------------------------------|-------------------------------------|--------|-------|
 * | `message.created.v1` (with mentions)   | each person mentioned               | yes    | yes   |
 * | `document.comment_created.v1`          | the people mentioned, the author    | yes    | yes   |
 * | `meeting.attendee_invited.v1`          | the invitee (a member or a client)  | yes    | yes   |
 * | `meeting.changed.v1` (BK5)             | the attendees when it changed       | yes    | yes   |
 * | `meeting.attendee_responded.v1`        | the organizer (answer from calendar)| yes    | no    |
 * | `project.member_added.v1`              | the person added                    | yes    | yes   |
 * | `work_item.client_action_requested.v1` | client people who may decide        | portal | yes   |
 * | `approval.requested.v1` (NT1)          | the picked client deciders          | yes    | yes   |
 * | `client_request.message_posted.v1`     | the other side of the request (NT1) | yes    | yes   |
 * | `approval.decided.v1` (Q3)             | the sender, the deliverable makers  | yes    | yes   |
 *
 * ## One shape for all five
 *
 * Each event has a **planner** that turns it into notices, one per recipient, after re-checking
 * that recipient's access from the current rows (§6): an active internal membership whose role
 * holds the read capability and that reaches the project — org-wide scope or a project seat — and,
 * for a channel, a seat in the channel. A notice then follows one path: the per-kind opt-out
 * (x152's `notification_kind_prefs`, honoured here at delivery — "Mentions" is the kind CQ-12
 * added), the in-app row (idempotent by its dedupe key), and the email — NOTIF-001's mail toggle,
 * then INBOX-001's quiet hours, deferred **per recipient** on the resume type exactly as the
 * usage mail does, then a send staged after commit.
 *
 * The resume handler re-plans the original event, which re-checks access, and mails only the one
 * recipient the resume row names — so a deferral never re-mails the others and never reaches a
 * person whose access went in the meantime.
 */

/** The subject half of an email; the recipient half is read at delivery. */
type MailSubject = Omit<CollaborationEmailFacts, 'recipientEmail' | 'recipientName' | 'locale'>;

export interface PlannedNotice {
  readonly recipientUserId: string;
  /** The opt-out kind (`notification_kind_prefs.kind`), or null when the notice has none. */
  readonly optOutKind: string | null;
  /** The membership the opt-out is keyed by; null for a client recipient. */
  readonly membershipId: string | null;
  /** The in-app row, or null for an email-only notice (a client's portal lists it already). */
  readonly inApp: {
    readonly type: string;
    readonly objectType: string;
    readonly objectId: string;
    readonly dedupeKey: string;
  } | null;
  /** The email, or null for an in-app-only notice (R4: a resolved review thread). */
  readonly mailKind: CollaborationMailKind | null;
  readonly mail: () => Promise<MailSubject | null>;
  /**
   * QA-FIX-O H1. The `approval_email_sends` row this notice's e-mail settles (sent, failed or not
   * sent and why), or absent when the producer keeps no delivery state for it.
   */
  readonly emailSendId?: string;
  /**
   * QA-FIX-O H1. The producer named this person, but they may no longer be told (no access):
   * nothing is written or sent; only the delivery row is settled `not_sent`.
   */
  readonly blocked?: 'no_access';
}

export type NoticePlanner = (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
  mailer: CollaborationMailer | null,
) => Promise<readonly PlannedNotice[]>;

function payloadOf(event: ClaimedOutboxEvent): Record<string, unknown> {
  if (event.payload !== null && typeof event.payload === 'object') {
    return event.payload as Record<string, unknown>;
  }
  throw new Error(`event ${event.id} has no readable payload`);
}

function stringField(payload: Record<string, unknown>, key: string, eventId: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`event ${eventId} has no readable ${key}`);
  return value;
}

/** A `{ userId: id }` object of strings; anything else in it is ignored. */
function idMap(payload: Record<string, unknown>, key: string): ReadonlyMap<string, string> {
  const value = payload[key];
  const out = new Map<string, string>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [userId, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === 'string' && id !== '') out.set(userId, id);
  }
  return out;
}

function idList(payload: Record<string, unknown>, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * The internal reach rule: a role that holds `capability`, and the project within reach — the
 * evaluator's relation rule restated from the same facts (org-wide scope or a project seat).
 * Pure so the unit suite can enumerate it.
 */
export function mayBeTold(reach: InternalReach | null, capability: Capability): boolean {
  if (reach === null) return false;
  // H1: `reach.role` is already resolved, so a custom-role member is judged by their own set.
  if (!roleHolds(reach.role, capability)) return false;
  return reach.hasOrgWideScope || reach.onProject;
}

/**
 * A client person who may decide. A client membership never holds a custom role (the API's
 * resolver refuses one), so only a built-in **client** role counts — an internal role name on a
 * client row is refused there too, and is refused here.
 */
export function mayClientDecide(role: string): boolean {
  return isClientRole(role) && hasCapability(role, 'approval.decide');
}

/** A readable UTC time for an email — "2026-10-20 14:30 UTC". */
export function formatUtc(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

async function organizationOf(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<{ readonly slug: string; readonly name: string } | null> {
  return findOrganizationFacts(tx, organizationId);
}

// ─── Planners ──────────────────────────────────────────────────────────────────

/** `message.created.v1` → each person the message mentions who can still read the channel. */
export const planMentionNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const mentioned = idList(raw, 'mentionedUserIds');
  if (mentioned.length === 0) return [];
  const messageId = stringField(raw, 'messageId', event.id);
  const conversationId = stringField(raw, 'conversationId', event.id);
  // R7 slice 6: a group or a direct conversation carries no project (`projectId: null`).
  const projectId = raw['projectId'] === null ? null : stringField(raw, 'projectId', event.id);
  const authorUserId = typeof raw['authorUserId'] === 'string' ? raw['authorUserId'] : null;

  const notices: PlannedNotice[] = [];
  for (const userId of mentioned) {
    if (userId === authorUserId) continue;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId ?? '');
    if (projectId === null) {
      // Member-gated for everyone, org-wide scope included: the role must read conversations
      // and the person must be in the room.
      if (reach === null || !roleHolds(reach.role, 'conversation.read')) continue;
      if (!(await isConversationMember(tx, event.organizationId, conversationId, userId))) continue;
    } else {
      if (!mayBeTold(reach, 'conversation.read') || reach === null) continue;
      if (
        !reach.hasOrgWideScope &&
        !(await isConversationMember(tx, event.organizationId, conversationId, userId))
      ) {
        continue; // Not in the room: a mention there is not theirs to read.
      }
    }
    notices.push({
      recipientUserId: userId,
      optOutKind: 'mention',
      membershipId: reach.membershipId,
      inApp: {
        type: 'message.mentioned.v1',
        objectType: 'conversation',
        objectId: conversationId,
        dedupeKey: `message.mentioned:${messageId}`,
      },
      mailKind: 'mention',
      mail: async () => {
        if (mailer === null) return null;
        const org = await organizationOf(tx, event.organizationId);
        const conversation = await findConversationFacts(tx, event.organizationId, conversationId);
        if (org === null || conversation === null) return null;
        const actor = authorUserId === null ? null : await findDisplayName(tx, authorUserId);
        const project =
          projectId === null ? null : await findProjectName(tx, event.organizationId, projectId);
        return {
          organizationName: org.name,
          ...(actor === null ? {} : { actorName: actor }),
          subjectTitle: projectId === null ? conversation.name : `#${conversation.name}`,
          ...(project === null ? {} : { projectName: project }),
          link: mailer.linkTo(`/${org.slug}/chat/${conversationId}`),
        };
      },
    });
  }
  return notices;
};

/** `document.comment_created.v1` → the people mentioned, then the document's author. */
export const planCommentNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const documentId = stringField(raw, 'documentId', event.id);
  const commentId = stringField(raw, 'commentId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const authorUserId = stringField(raw, 'authorUserId', event.id);
  const document = await findDocumentFacts(tx, event.organizationId, documentId);
  if (document === null) return []; // Gone: nothing safe to reference.

  const recipients: { readonly userId: string; readonly mentioned: boolean }[] = [];
  for (const userId of idList(raw, 'mentionedUserIds')) {
    if (userId !== authorUserId) recipients.push({ userId, mentioned: true });
  }
  if (
    document.createdByUserId !== authorUserId &&
    !recipients.some((recipient) => recipient.userId === document.createdByUserId)
  ) {
    recipients.push({ userId: document.createdByUserId, mentioned: false });
  }

  const notices: PlannedNotice[] = [];
  for (const recipient of recipients) {
    const reach = await findInternalReach(tx, event.organizationId, recipient.userId, projectId);
    if (!mayBeTold(reach, 'work.read') || reach === null) continue;
    const mailKind: CollaborationMailKind = recipient.mentioned ? 'mention' : 'comment';
    notices.push({
      recipientUserId: recipient.userId,
      optOutKind: recipient.mentioned ? 'mention' : 'message',
      membershipId: reach.membershipId,
      inApp: {
        type: recipient.mentioned ? 'document.mentioned.v1' : 'document.comment_created.v1',
        objectType: 'document',
        objectId: documentId,
        dedupeKey: `document.comment:${commentId}`,
      },
      mailKind,
      mail: async () => {
        if (mailer === null) return null;
        const org = await organizationOf(tx, event.organizationId);
        if (org === null) return null;
        const actor = await findDisplayName(tx, authorUserId);
        const project = await findProjectName(tx, event.organizationId, projectId);
        return {
          organizationName: org.name,
          ...(actor === null ? {} : { actorName: actor }),
          subjectTitle: document.title,
          ...(project === null ? {} : { projectName: project }),
          link: mailer.linkTo(`/${org.slug}/docs/${documentId}`),
        };
      },
    });
  }
  return notices;
};

/**
 * BK5: is a client person still allowed to hear about a meeting on `projectId` — their client
 * membership active and unexpired, and the project still shared with their company.
 */
async function clientMayBeTold(
  tx: WorkerTransaction,
  organizationId: string,
  userId: string,
  clientOrganizationId: string,
  projectId: string,
): Promise<boolean> {
  return clientRecipientStillPermitted(tx, {
    organizationId,
    userId,
    clientOrganizationId,
    projectId,
  });
}

/** `meeting.attendee_invited.v1` → the invitee — a member, or (BK5) a client person. */
export const planMeetingInviteNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const meetingId = stringField(raw, 'meetingId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const attendeeUserId = stringField(raw, 'attendeeUserId', event.id);
  const invitedByUserId = stringField(raw, 'invitedByUserId', event.id);
  if (attendeeUserId === invitedByUserId) return [];

  const mail = (portal: boolean) => async (): Promise<MailSubject | null> => {
    if (mailer === null) return null;
    const org = await organizationOf(tx, event.organizationId);
    const meeting = await findMeetingFacts(tx, event.organizationId, meetingId);
    if (org === null || meeting === null) return null;
    const actor = await findDisplayName(tx, invitedByUserId);
    const project = await findProjectName(tx, event.organizationId, projectId);
    return {
      organizationName: org.name,
      ...(portal ? { portal: true } : {}),
      ...(actor === null ? {} : { actorName: actor }),
      subjectTitle: meeting.title,
      ...(project === null ? {} : { projectName: project }),
      when: formatUtc(meeting.startsAt),
      link: mailer.linkTo(
        portal
          ? `/${org.slug}/portal/meetings/${meetingId}`
          : `/${org.slug}/calendar/meetings/${meetingId}`,
      ),
    };
  };
  const inApp = {
    type: 'meeting.attendee_invited.v1',
    objectType: 'meeting',
    objectId: meetingId,
    // The event id: an invite after a removal is news again; a redelivery is not.
    dedupeKey: `meeting.invited:${event.id}`,
  };

  if (raw['attendeeKind'] === 'client') {
    const clientOrganizationId = stringField(raw, 'clientOrganizationId', event.id);
    if (
      !(await clientMayBeTold(
        tx,
        event.organizationId,
        attendeeUserId,
        clientOrganizationId,
        projectId,
      ))
    ) {
      return [];
    }
    return [
      {
        recipientUserId: attendeeUserId,
        optOutKind: null,
        membershipId: null,
        inApp,
        mailKind: 'meeting_invite',
        mail: mail(true),
      },
    ];
  }

  const reach = await findInternalReach(tx, event.organizationId, attendeeUserId, projectId);
  if (!mayBeTold(reach, 'work.read') || reach === null) return [];
  return [
    {
      recipientUserId: attendeeUserId,
      optOutKind: null,
      membershipId: reach.membershipId,
      inApp,
      mailKind: 'meeting_invite',
      mail: mail(false),
    },
  ];
};

/**
 * `meeting.changed.v1` → BK5. The title, date or time of a meeting changed: everyone who was on the
 * roster at that moment (the payload's snapshot — a person added afterwards gets the invitation
 * instead) is told, except whoever made the change. Each is re-checked from the current rows: a
 * member must still reach the project with `work.read`, a client person must still hold an active
 * client membership whose company the project is shared with. The email carries the new time.
 */
export const planMeetingChangedNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const meetingId = stringField(raw, 'meetingId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const changedByUserId = stringField(raw, 'changedByUserId', event.id);
  const meeting = await findMeetingFacts(tx, event.organizationId, meetingId);
  if (meeting === null) return []; // Gone: nothing safe to reference.

  const inApp = {
    type: 'meeting.changed.v1',
    objectType: 'meeting',
    objectId: meetingId,
    // One change, one notice per person; a redelivery is not news.
    dedupeKey: `meeting.changed:${event.id}`,
  };
  const mail = (portal: boolean) => async (): Promise<MailSubject | null> => {
    if (mailer === null) return null;
    const org = await organizationOf(tx, event.organizationId);
    if (org === null) return null;
    const actor = await findDisplayName(tx, changedByUserId);
    const project = await findProjectName(tx, event.organizationId, projectId);
    return {
      organizationName: org.name,
      ...(portal ? { portal: true } : {}),
      ...(actor === null ? {} : { actorName: actor }),
      subjectTitle: meeting.title,
      ...(project === null ? {} : { projectName: project }),
      when: formatUtc(meeting.startsAt),
      link: mailer.linkTo(
        portal
          ? `/${org.slug}/portal/meetings/${meetingId}`
          : `/${org.slug}/calendar/meetings/${meetingId}`,
      ),
    };
  };

  const notices: PlannedNotice[] = [];
  const told = new Set<string>([changedByUserId]);
  for (const userId of idList(raw, 'memberUserIds')) {
    if (told.has(userId)) continue;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
    if (!mayBeTold(reach, 'work.read') || reach === null) continue;
    told.add(userId);
    notices.push({
      recipientUserId: userId,
      optOutKind: null,
      membershipId: reach.membershipId,
      inApp,
      mailKind: 'meeting_changed',
      mail: mail(false),
    });
  }
  const clients = Array.isArray(raw['clientAttendees']) ? raw['clientAttendees'] : [];
  for (const entry of clients) {
    if (entry === null || typeof entry !== 'object') continue;
    const { userId, clientOrganizationId } = entry as Record<string, unknown>;
    if (typeof userId !== 'string' || typeof clientOrganizationId !== 'string') continue;
    if (told.has(userId)) continue;
    if (
      !(await clientMayBeTold(tx, event.organizationId, userId, clientOrganizationId, projectId))
    ) {
      continue;
    }
    told.add(userId);
    notices.push({
      recipientUserId: userId,
      optOutKind: null,
      membershipId: null,
      inApp,
      mailKind: 'meeting_changed',
      mail: mail(true),
    });
  }
  return notices;
};

/**
 * `meeting.attendee_responded.v1` → fix 2026-11-09. Someone answered the meeting in Google Calendar
 * or Outlook and the calendar pull wrote it: the meeting's organizer (read from the meeting row
 * now, not from the payload) is told in the inbox. Never when the organizer answered themselves;
 * never once the organizer no longer reaches the project with `work.read`. In-app only (no mail
 * template); the per-kind switch applies through the routing table's `work_item` row.
 */
export const planMeetingResponseNotices: NoticePlanner = async (event, tx) => {
  const raw = payloadOf(event);
  const meetingId = stringField(raw, 'meetingId', event.id);
  const attendeeId = stringField(raw, 'attendeeId', event.id);
  const response = stringField(raw, 'response', event.id);
  if (!['accepted', 'declined', 'tentative'].includes(response)) return [];
  const attendeeUserId = typeof raw['attendeeUserId'] === 'string' ? raw['attendeeUserId'] : null;
  const meeting = await findMeetingFacts(tx, event.organizationId, meetingId);
  if (meeting === null) return []; // Gone: nothing safe to reference.
  const organizerUserId = meeting.createdByUserId;
  if (attendeeUserId === organizerUserId) return [];

  const reach = await findInternalReach(
    tx,
    event.organizationId,
    organizerUserId,
    meeting.projectId,
  );
  if (!mayBeTold(reach, 'work.read') || reach === null) return [];
  return [
    {
      recipientUserId: organizerUserId,
      optOutKind: null,
      membershipId: reach.membershipId,
      inApp: {
        type: 'meeting.attendee_responded.v1',
        objectType: 'meeting',
        objectId: meetingId,
        // The event id: each answer that changed is news once; a redelivery is not.
        dedupeKey: `meeting.responded:${attendeeId}:${event.id}`,
      },
      mailKind: null,
      mail: async () => null,
    },
  ];
};

/** `project.member_added.v1` → the person put on the project. */
export const planProjectAddedNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const projectId = stringField(raw, 'projectId', event.id);
  const userId = stringField(raw, 'userId', event.id);
  const addedByUserId = stringField(raw, 'addedByUserId', event.id);
  if (userId === addedByUserId) return [];

  const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
  if (!mayBeTold(reach, 'work.read') || reach === null) return [];
  return [
    {
      recipientUserId: userId,
      optOutKind: null,
      membershipId: reach.membershipId,
      inApp: {
        type: 'project.member_added.v1',
        objectType: 'project',
        objectId: projectId,
        dedupeKey: `project.member_added:${event.id}`,
      },
      mailKind: 'project_added',
      mail: async () => {
        if (mailer === null) return null;
        const org = await organizationOf(tx, event.organizationId);
        const project = await findProjectName(tx, event.organizationId, projectId);
        if (org === null || project === null) return null;
        const actor = await findDisplayName(tx, addedByUserId);
        return {
          organizationName: org.name,
          ...(actor === null ? {} : { actorName: actor }),
          subjectTitle: project,
          link: mailer.linkTo(`/${org.slug}/projects/${projectId}`),
        };
      },
    },
  ];
};

/**
 * `work_item.people_assigned.v1` → C26. Each person newly made a doer or supervisor of a work item
 * is told in-app, if they are still an active internal member who may read work on the project.
 * Clients are never named (the people routes accept internal members only) and never told here.
 * C27: and by email (`people_assigned`), through the same opt-out, mail toggle and quiet hours.
 */
export const planPeopleAssignedNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const workItemId = stringField(raw, 'workItemId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const assignedByUserId = stringField(raw, 'assignedByUserId', event.id);
  const role = raw['role'] === 'supervisor' ? 'supervisor' : 'doer';
  const notices: PlannedNotice[] = [];
  for (const userId of idList(raw, 'userIds')) {
    if (userId === assignedByUserId) continue;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
    if (!mayBeTold(reach, 'work.read') || reach === null) continue;
    notices.push(
      workNotice(
        userId,
        reach.membershipId,
        'work_item.people_assigned.v1',
        workItemId,
        `work_item.people_assigned:${event.id}:${userId}`,
        {
          tx,
          event,
          mailer,
          kind: 'people_assigned',
          projectId,
          actorUserId: assignedByUserId,
          role,
        },
      ),
    );
  }
  return notices;
};

/**
 * `work_item.comment_created.v1` → 53-11. Each person a work-item comment @mentions is told
 * (in-app, kind `mention`, and by email through the same opt-out, mail toggle and quiet hours) —
 * but only if they are still an active internal member who may read work on the item's project.
 * The API already narrowed the list to people who can see the item; this re-checks at delivery.
 */
export const planWorkItemMentionNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const mentioned = idList(raw, 'mentionedUserIds');
  if (mentioned.length === 0) return [];
  const workItemId = stringField(raw, 'workItemId', event.id);
  const commentId = stringField(raw, 'commentId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const authorUserId = stringField(raw, 'authorUserId', event.id);
  const item = await findWorkItemFacts(tx, event.organizationId, workItemId);
  if (item === null) return []; // Gone: nothing safe to reference.

  const notices: PlannedNotice[] = [];
  for (const userId of mentioned) {
    if (userId === authorUserId) continue;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
    if (!mayBeTold(reach, 'work.read') || reach === null) continue;
    notices.push({
      recipientUserId: userId,
      optOutKind: 'mention',
      membershipId: reach.membershipId,
      inApp: {
        type: 'work_item.mentioned.v1',
        objectType: 'work_item',
        objectId: workItemId,
        dedupeKey: `work_item.mentioned:${commentId}:${userId}`,
      },
      mailKind: 'mention',
      mail: async () => {
        if (mailer === null) return null;
        const org = await organizationOf(tx, event.organizationId);
        if (org === null) return null;
        const actor = await findDisplayName(tx, authorUserId);
        const project = await findProjectName(tx, event.organizationId, projectId);
        return {
          organizationName: org.name,
          ...(actor === null ? {} : { actorName: actor }),
          subjectTitle: item.title,
          ...(project === null ? {} : { projectName: project }),
          link: mailer.linkTo(`/${org.slug}/work/${workItemId}`),
        };
      },
    });
  }
  return notices;
};

/**
 * `work_item.updated.v1` into `internal_review` → C26/C27. A task with supervisors is completed by
 * one of them (the API refuses anyone else's move to done), so a doer's "Mark done" stops in
 * internal review: that is when its supervisors are told, in-app and by email
 * (`supervised_done`), that it waits for their approval. The person who made the move is skipped.
 * Any other state tells nobody.
 */
export const planSupervisorDoneNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  if (raw['toState'] !== 'internal_review') return [];
  const workItemId = stringField(raw, 'workItemId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const actorUserId = typeof raw['actorUserId'] === 'string' ? raw['actorUserId'] : null;
  const notices: PlannedNotice[] = [];
  for (const userId of await listWorkItemSupervisors(tx, event.organizationId, workItemId)) {
    if (userId === actorUserId) continue;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
    if (!mayBeTold(reach, 'work.read') || reach === null) continue;
    notices.push(
      workNotice(
        userId,
        reach.membershipId,
        'work_item.supervised_done.v1',
        workItemId,
        `work_item.supervised_done:${event.id}:${userId}`,
        { tx, event, mailer, kind: 'supervised_done', projectId, actorUserId, role: 'supervisor' },
      ),
    );
  }
  return notices;
};

interface WorkMailContext {
  readonly tx: WorkerTransaction;
  readonly event: ClaimedOutboxEvent;
  readonly mailer: CollaborationMailer | null;
  readonly kind: 'people_assigned' | 'supervised_done';
  readonly projectId: string;
  readonly actorUserId: string | null;
  readonly role: 'doer' | 'supervisor';
}

function workNotice(
  userId: string,
  membershipId: string,
  type: string,
  workItemId: string,
  dedupeKey: string,
  mail: WorkMailContext,
): PlannedNotice {
  const { tx, event, mailer } = mail;
  return {
    recipientUserId: userId,
    optOutKind: null,
    membershipId,
    inApp: { type, objectType: 'work_item', objectId: workItemId, dedupeKey },
    mailKind: mailer === null ? null : mail.kind,
    mail: async () => {
      if (mailer === null) return null;
      const org = await organizationOf(tx, event.organizationId);
      const item = await findWorkItemFacts(tx, event.organizationId, workItemId);
      if (org === null || item === null) return null;
      const project = await findProjectName(tx, event.organizationId, mail.projectId);
      const actor = mail.actorUserId === null ? null : await findDisplayName(tx, mail.actorUserId);
      return {
        organizationName: org.name,
        ...(actor === null ? {} : { actorName: actor }),
        subjectTitle: item.title,
        ...(project === null ? {} : { projectName: project }),
        assigneeRole: mail.role,
        link: mailer.linkTo(`/${org.slug}/work/${workItemId}`),
      };
    },
  };
}

/**
 * `work_item.client_action_requested.v1` → APR-03. Every client person who may decide
 * (`approval.decide` — admin, reviewer, member; never a viewer) and whose client organization the
 * project is still shared with, while the item is still waiting on the client. Email only: the
 * portal's "My actions" already lists it, which is where the link goes.
 */
export const planClientActionNotices: NoticePlanner = async (event, tx, mailer) => {
  if (mailer === null) return []; // Email-only: nothing to do without a transport.
  const raw = payloadOf(event);
  const workItemId = stringField(raw, 'workItemId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const item = await findWorkItemFacts(tx, event.organizationId, workItemId);
  if (item === null || item.audience !== 'client_action_required') return [];

  const people = await listProjectClientPeople(tx, event.organizationId, projectId);
  // C25: an item narrowed to some of the project's client companies asks only their people.
  const listed = await listWorkItemClientAudience(tx, event.organizationId, workItemId);
  return people
    .filter((person) => mayClientDecide(person.role))
    .filter(
      (person) =>
        listed.length === 0 ||
        (person.clientOrganizationId !== undefined && listed.includes(person.clientOrganizationId)),
    )
    .map((person): PlannedNotice => ({
      recipientUserId: person.userId,
      optOutKind: null,
      membershipId: null,
      inApp: null,
      mailKind: 'client_action',
      mail: async () => {
        const org = await organizationOf(tx, event.organizationId);
        if (org === null) return null;
        const project = await findProjectName(tx, event.organizationId, projectId);
        return {
          organizationName: org.name,
          subjectTitle: item.title,
          ...(project === null ? {} : { projectName: project }),
          link: mailer.linkTo(`/${org.slug}/portal/actions`),
          portal: true,
        };
      },
    }));
};

/**
 * `approval.requested.v1` → APR-01/02 (0211), NT1. A deliverable version was sent to the client for
 * approval: each client person on the project who may decide (`approval.decide`, never a viewer)
 * and — when the sender picked reviewers — is one of them, gets an in-app row and a "please review"
 * email linking the portal's Approve screen for that exact version. The subject is the project,
 * since the worker holds no read on `deliverables`.
 */
export const planApprovalRequestedNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const projectId = stringField(raw, 'projectId', event.id);
  const versionId = stringField(raw, 'deliverableVersionId', event.id);
  const approvalId = typeof raw['approvalId'] === 'string' ? raw['approvalId'] : event.id;
  const picked = new Set(idList(raw, 'reviewerUserIds'));
  const sendIds = idMap(raw, 'emailSendIds');
  const withSend = (userId: string) =>
    sendIds.has(userId) ? { emailSendId: sendIds.get(userId) as string } : {};

  const people = await listProjectClientPeople(tx, event.organizationId, projectId);
  const deciders = people
    .filter((person) => mayClientDecide(person.role))
    .filter((person) => picked.size === 0 || picked.has(person.userId));
  // QA-FIX-O H1: a picked approver who may no longer decide is told nothing, and their e-mail row
  // says so instead of waiting for ever.
  const reachable = new Set(deciders.map((person) => person.userId));
  const blocked = [...picked]
    .filter((userId) => !reachable.has(userId))
    .map((userId): PlannedNotice => ({
      recipientUserId: userId,
      optOutKind: null,
      membershipId: null,
      inApp: null,
      mailKind: null,
      mail: async () => null,
      blocked: 'no_access',
      ...withSend(userId),
    }));
  return [
    ...blocked,
    ...deciders.map((person): PlannedNotice => ({
      ...withSend(person.userId),
      recipientUserId: person.userId,
      optOutKind: null,
      membershipId: null,
      inApp: {
        type: 'approval.requested.v1',
        objectType: 'deliverable_version',
        objectId: versionId,
        // One approval per send: a re-send after changes is a new approval, so news again.
        dedupeKey: `approval.requested:${approvalId}`,
      },
      mailKind: 'approval_requested',
      mail: async () => {
        if (mailer === null) return null;
        const org = await organizationOf(tx, event.organizationId);
        const project = await findProjectName(tx, event.organizationId, projectId);
        if (org === null || project === null) return null;
        return {
          organizationName: org.name,
          subjectTitle: project,
          link: mailer.linkTo(`/${org.slug}/portal/deliverables/${versionId}`),
          portal: true,
        };
      },
    })),
  ];
};

/**
 * `client_request.message_posted.v1` → NT1 (BG3). A message on a client request tells the other
 * side, re-checked from the current rows:
 *
 * - a **client** posted → every internal member who may triage the request and reaches its
 *   project (`client_request.triage`, org-wide scope or a project seat — the submitted notice's
 *   rule), honouring the "message" opt-out; the email names the client author;
 * - a **team member** posted a client-visible message → the person who filed the request, while
 *   their client membership is active and the project still shared; the email names the studio,
 *   never a staff member (the portal shows "from studio");
 * - an internal-only message (`clientVisible: false`) → nobody.
 */
export const planRequestMessageNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const requestId = stringField(raw, 'requestId', event.id);
  const messageId = stringField(raw, 'messageId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const clientOrganizationId = stringField(raw, 'clientOrganizationId', event.id);
  const authorMembershipId = stringField(raw, 'authorMembershipId', event.id);
  const authorKind = raw['authorKind'] === 'client' ? 'client' : 'internal';
  if (authorKind === 'internal' && raw['clientVisible'] !== true) return [];

  const request = await findClientRequestFacts(tx, event.organizationId, requestId);
  if (request === null) return []; // Gone: nothing safe to reference.
  const inApp = {
    type: 'client_request.message_posted.v1',
    objectType: 'client_request',
    objectId: requestId,
    dedupeKey: `client_request.message:${messageId}`,
  };
  const subject = async (portal: boolean): Promise<MailSubject | null> => {
    if (mailer === null) return null;
    const org = await organizationOf(tx, event.organizationId);
    if (org === null) return null;
    const actor = portal
      ? null
      : await findMembershipDisplayName(tx, event.organizationId, authorMembershipId, 'client');
    const project = await findProjectName(tx, event.organizationId, projectId);
    return {
      organizationName: org.name,
      ...(portal ? { portal: true } : {}),
      ...(actor === null ? {} : { actorName: actor }),
      subjectTitle: request.title,
      ...(project === null ? {} : { projectName: project }),
      link: mailer.linkTo(
        portal
          ? `/${org.slug}/portal/requests/${requestId}`
          : `/${org.slug}/work/requests/${requestId}`,
      ),
    };
  };

  if (authorKind === 'internal') {
    const permitted = await clientRecipientStillPermitted(tx, {
      organizationId: event.organizationId,
      userId: request.submittedByUserId,
      clientOrganizationId,
      projectId,
    });
    if (!permitted) return [];
    return [
      {
        recipientUserId: request.submittedByUserId,
        optOutKind: null,
        membershipId: null,
        inApp,
        mailKind: 'request_message',
        mail: () => subject(true),
      },
    ];
  }

  const candidates = await listActiveInternalMemberships(tx, event.organizationId, projectId);
  const notices: PlannedNotice[] = [];
  for (const candidate of candidates) {
    const reach = await findInternalReach(tx, event.organizationId, candidate.userId, projectId);
    if (!mayBeTold(reach, 'client_request.triage') || reach === null) continue;
    notices.push({
      recipientUserId: candidate.userId,
      optOutKind: 'message',
      membershipId: reach.membershipId,
      inApp,
      mailKind: 'request_message',
      mail: () => subject(false),
    });
  }
  return notices;
};

/**
 * `approval.decided.v1` → Q3. A client (or a staff reviewer) approved or requested changes: the
 * internal side is told — the person who sent it (`requestedByUserId`) and every internal member
 * who may create deliverables (`deliverable.create`) and reaches the project. Never a client, and
 * never the person who decided. Uses the "message" opt-out; the email bypasses quiet hours because
 * `approval.decided.v1` is `yes-critical` in domain `quiet-hours.ts`. The worker holds no read on
 * `deliverables`, so the email names the decider and the project, never the deliverable title.
 */
export const planApprovalDecidedNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const approvalId = stringField(raw, 'approvalId', event.id);
  const deliverableId = stringField(raw, 'deliverableId', event.id);
  const versionId = stringField(raw, 'deliverableVersionId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const decidedByUserId = stringField(raw, 'decidedByUserId', event.id);
  const requestedByUserId =
    typeof raw['requestedByUserId'] === 'string' ? raw['requestedByUserId'] : null;
  const decision = raw['decision'] === 'approved' ? 'approved' : 'changes_requested';

  const recipients: { readonly userId: string; readonly membershipId: string }[] = [];
  const consider = async (userId: string, capability: Capability): Promise<void> => {
    if (userId === decidedByUserId || recipients.some((r) => r.userId === userId)) return;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
    if (!mayBeTold(reach, capability) || reach === null) return;
    recipients.push({ userId, membershipId: reach.membershipId });
  };
  if (requestedByUserId !== null) await consider(requestedByUserId, 'work.read');
  for (const candidate of await listActiveInternalMemberships(
    tx,
    event.organizationId,
    projectId,
  )) {
    await consider(candidate.userId, 'deliverable.create');
  }

  const mail = async (): Promise<MailSubject | null> => {
    if (mailer === null) return null;
    const org = await organizationOf(tx, event.organizationId);
    const project = await findProjectName(tx, event.organizationId, projectId);
    if (org === null || project === null) return null;
    const actor = await findDisplayName(tx, decidedByUserId);
    return {
      organizationName: org.name,
      actorName: actor ?? project,
      subjectTitle: project,
      projectName: project,
      decision,
      link: mailer.linkTo(`/${org.slug}/projects/${projectId}/deliverables/${deliverableId}`),
    };
  };
  return recipients.map((recipient): PlannedNotice => ({
    recipientUserId: recipient.userId,
    optOutKind: 'message',
    membershipId: recipient.membershipId,
    inApp: {
      type: 'approval.decided.v1',
      objectType: 'deliverable_version',
      objectId: versionId,
      dedupeKey: `approval.decided:${approvalId}`,
    },
    mailKind: 'approval_decided',
    mail,
  }));
};

/** The planners by event type — the set `registry.ts` registers and the resume path re-plans. */
export const COLLABORATION_PLANNERS: Readonly<Record<string, NoticePlanner>> = {
  'message.created.v1': planMentionNotices,
  'document.comment_created.v1': planCommentNotices,
  'meeting.attendee_invited.v1': planMeetingInviteNotices,
  'meeting.changed.v1': planMeetingChangedNotices,
  'meeting.attendee_responded.v1': planMeetingResponseNotices,
  'project.member_added.v1': planProjectAddedNotices,
  'work_item.client_action_requested.v1': planClientActionNotices,
  'approval.requested.v1': planApprovalRequestedNotices,
  'client_request.message_posted.v1': planRequestMessageNotices,
  'approval.decided.v1': planApprovalDecidedNotices,
  // C27: both now mail, so a quiet-hours resume re-plans them like the others.
  'work_item.people_assigned.v1': planPeopleAssignedNotices,
  'work_item.updated.v1': planSupervisorDoneNotices,
  // 53-11: @mentions in a work item's comments.
  'work_item.comment_created.v1': planWorkItemMentionNotices,
};

// ─── Delivery ──────────────────────────────────────────────────────────────────

/** QA-FIX-O H1. Settle a notice's delivery row inside the handler's transaction. */
async function settleInTx(
  tx: WorkerTransaction,
  event: ClaimedOutboxEvent,
  notice: PlannedNotice,
  outcome: ApprovalEmailOutcome,
): Promise<void> {
  if (notice.emailSendId === undefined) return;
  await settleApprovalEmailSend(
    tx,
    { organizationId: event.organizationId, sendRowId: notice.emailSendId },
    outcome,
  );
}

const MAIL_OFF: ApprovalEmailOutcome = { state: 'not_sent', cause: 'mail_off' };
const NO_ACCESS: ApprovalEmailOutcome = { state: 'not_sent', cause: 'no_access' };
const NO_TRANSPORT: ApprovalEmailOutcome = { state: 'not_sent', cause: 'no_transport' };

async function stageMail(input: {
  readonly event: ClaimedOutboxEvent;
  readonly tx: WorkerTransaction;
  readonly effects: Parameters<OutboxHandler>[2];
  readonly mailer: CollaborationMailer;
  readonly notice: PlannedNotice;
  readonly deferForQuietHours: boolean;
  readonly settler: ApprovalEmailSettler | null;
}): Promise<void> {
  const { event, tx, effects, mailer, notice } = input;
  const kind = notice.mailKind;
  if (kind === null) return; // In-app only: no email, and nothing to defer past quiet hours.
  const recipient = await findUsageMailRecipient(tx, event.organizationId, notice.recipientUserId);
  if (recipient === null || !recipient.emailEnabled) {
    // Gone, or mail turned off.
    await settleInTx(tx, event, notice, recipient === null ? NO_ACCESS : MAIL_OFF);
    return;
  }

  if (input.deferForQuietHours) {
    const now = new Date();
    if (isInQuietHours(now, recipient.quietHours)) {
      const resumeAt = quietHoursResumeAt(now, recipient.quietHours);
      if (resumeAt !== null) {
        await enqueueQuietHoursMailResume(tx, event, resumeAt, notice.recipientUserId);
        return; // This recipient's email waits for their window to end; the inbox row is in.
      }
    }
  }

  const subject = await notice.mail();
  if (subject === null) {
    await settleInTx(tx, event, notice, NO_ACCESS);
    return;
  }
  const sendRowId = notice.emailSendId;
  const settler = input.settler;
  effects.afterCommit(async () => {
    const delivery = await mailer.deliver(kind, {
      ...subject,
      organizationId: event.organizationId,
      recipientEmail: recipient.email,
      recipientName: recipient.displayName,
      locale: recipient.locale,
    });
    if (sendRowId === undefined || settler === null) return;
    const outcome: ApprovalEmailOutcome =
      delivery === 'none' ? NO_TRANSPORT : { state: delivery, cause: null };
    try {
      await settler.settle({ organizationId: event.organizationId, sendRowId }, outcome);
    } catch (error) {
      // The mail already went (or did not); losing the stamp leaves the row `queued`, which the
      // page shows as still on its way and a resend unblocks after the hold. Never re-thrown:
      // an effect cannot be retried (dispatcher.ts).
      console.error(`[worker] ${kind} delivery state not recorded`, error);
    }
  });
}

/**
 * 53-15 — route one notice through the member's matrix: the notice's opt-out kind, or the kind its
 * type belongs to (so every type obeys the per-kind switch, not only the ones that named a kind),
 * then the member's In-app / E-mail cell. A client recipient (no membership) and an account notice
 * keep the unconditional path; the digest picks the inbox row up later when its cell asks for it.
 */
export async function routeNotice(
  tx: WorkerTransaction,
  event: ClaimedOutboxEvent,
  notice: PlannedNotice,
): Promise<DeliveryDecision> {
  const type = notice.inApp?.type ?? event.type;
  const named = notice.optOutKind;
  const kind: NaturalNotificationKind | null =
    named !== null && (MATRIX_KINDS as readonly string[]).includes(named)
      ? (named as NaturalNotificationKind)
      : matrixKindOf(type);
  if (notice.membershipId === null || kind === null) return decideDelivery(type, null);
  const cell = await findMemberMatrixCell(tx, event.organizationId, notice.membershipId, kind);
  return decideDelivery(type, cell);
}

/**
 * The original-delivery handler for one event type: plan, then opt-out, in-app, email.
 *
 * QA-FIX-O H1: a notice that names an `approval_email_sends` row always settles it — `not_sent`
 * with a cause when no e-mail will go (no access, mail off, no transport), else `sent` or `failed`
 * from the SMTP answer after commit (through `settler`) — so the deliverable page never shows a
 * send as on its way when nothing is going to happen.
 */
export function createCollaborationNotices(
  planner: NoticePlanner,
  mailer: CollaborationMailer | null,
  settler: ApprovalEmailSettler | null = null,
): OutboxHandler {
  const mails = mailer !== null && mailer.enabled ? mailer : null;
  return async (event, tx, effects) => {
    const notices = await planner(event, tx, mails);
    for (const notice of notices) {
      if (notice.blocked !== undefined) {
        await settleInTx(tx, event, notice, NO_ACCESS);
        continue;
      }
      const route = await routeNotice(tx, event, notice);
      if (!route.inApp) {
        // The person turned this kind off: neither inbox nor email.
        await settleInTx(tx, event, notice, MAIL_OFF);
        continue;
      }
      if (notice.inApp !== null) {
        await insertNotification(tx, {
          organizationId: event.organizationId,
          recipientUserId: notice.recipientUserId,
          ...notice.inApp,
        });
      }
      if (mails === null) {
        await settleInTx(tx, event, notice, NO_TRANSPORT);
      } else if (!route.email) {
        await settleInTx(tx, event, notice, MAIL_OFF);
      } else {
        await stageMail({
          event,
          tx,
          effects,
          mailer: mails,
          notice,
          // A `yes-critical` type (domain quiet-hours.ts) interrupts through the window.
          deferForQuietHours: !eventTypeBypassesQuietHours(event.type),
          settler,
        });
      }
    }
  };
}

/**
 * The quiet-hours resume for the collaboration emails. Acts only on a resume row whose original
 * type has a planner here and which names its one recipient; no-ops otherwise, so it composes with
 * the other resume handlers on the one type (`planners` defaults to this file's set; the registry adds
 * the R4 review planners). Re-plans the original event (re-checking access) and
 * mails that recipient alone, honouring a mail toggle or opt-out changed during the deferral.
 */
export function createCollaborationMailResume(
  mailer: CollaborationMailer,
  planners: Readonly<Record<string, NoticePlanner>> = COLLABORATION_PLANNERS,
  settler: ApprovalEmailSettler | null = null,
): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return;
    const envelope = decodeQuietHoursMailResume(event);
    if (envelope === null) return;
    const planner = planners[envelope.originalType];
    const recipientUserId = envelope.recipientUserId;
    if (planner === undefined || recipientUserId === undefined) return;

    const original = { ...event, type: envelope.originalType, payload: envelope.originalPayload };
    const notices = await planner(original, tx, mailer);
    for (const notice of notices) {
      if (notice.recipientUserId !== recipientUserId) continue;
      if (notice.blocked !== undefined) {
        await settleInTx(tx, event, notice, NO_ACCESS);
        continue;
      }
      if (!(await routeNotice(tx, original, notice)).email) {
        await settleInTx(tx, event, notice, MAIL_OFF);
        continue;
      }
      await stageMail({ event, tx, effects, mailer, notice, deferForQuietHours: false, settler });
    }
  };
}
