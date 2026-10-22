import { hasCapability, isInQuietHours, isRole, quietHoursResumeAt } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
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
  isNotificationKindEnabled,
  listProjectClientPeople,
} from '../common/database/collaboration-store.js';
import type { InternalReach } from '../common/database/collaboration-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
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
 * | `meeting.attendee_invited.v1`          | the invitee                         | yes    | yes   |
 * | `project.member_added.v1`              | the person added                    | yes    | yes   |
 * | `work_item.client_action_requested.v1` | client people who may decide        | portal | yes   |
 * | `approval.requested.v1` (NT1)          | the picked client deciders          | yes    | yes   |
 * | `client_request.message_posted.v1`     | the other side of the request (NT1) | yes    | yes   |
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
  readonly mailKind: CollaborationMailKind;
  readonly mail: () => Promise<MailSubject | null>;
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
  if (!isRole(reach.role) || !hasCapability(reach.role, capability)) return false;
  return reach.hasOrgWideScope || reach.onProject;
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
  const projectId = stringField(raw, 'projectId', event.id);
  const authorUserId = typeof raw['authorUserId'] === 'string' ? raw['authorUserId'] : null;

  const notices: PlannedNotice[] = [];
  for (const userId of mentioned) {
    if (userId === authorUserId) continue;
    const reach = await findInternalReach(tx, event.organizationId, userId, projectId);
    if (!mayBeTold(reach, 'conversation.read') || reach === null) continue;
    if (
      !reach.hasOrgWideScope &&
      !(await isConversationMember(tx, event.organizationId, conversationId, userId))
    ) {
      continue; // Not in the room: a mention there is not theirs to read.
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
        const project = await findProjectName(tx, event.organizationId, projectId);
        return {
          organizationName: org.name,
          ...(actor === null ? {} : { actorName: actor }),
          subjectTitle: `#${conversation.name}`,
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

/** `meeting.attendee_invited.v1` → the invitee. */
export const planMeetingInviteNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const meetingId = stringField(raw, 'meetingId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const attendeeUserId = stringField(raw, 'attendeeUserId', event.id);
  const invitedByUserId = stringField(raw, 'invitedByUserId', event.id);
  if (attendeeUserId === invitedByUserId) return [];

  const reach = await findInternalReach(tx, event.organizationId, attendeeUserId, projectId);
  if (!mayBeTold(reach, 'work.read') || reach === null) return [];
  return [
    {
      recipientUserId: attendeeUserId,
      optOutKind: null,
      membershipId: reach.membershipId,
      inApp: {
        type: 'meeting.attendee_invited.v1',
        objectType: 'meeting',
        objectId: meetingId,
        // The event id: an invite after a removal is news again; a redelivery is not.
        dedupeKey: `meeting.invited:${event.id}`,
      },
      mailKind: 'meeting_invite',
      mail: async () => {
        if (mailer === null) return null;
        const org = await organizationOf(tx, event.organizationId);
        const meeting = await findMeetingFacts(tx, event.organizationId, meetingId);
        if (org === null || meeting === null) return null;
        const actor = await findDisplayName(tx, invitedByUserId);
        const project = await findProjectName(tx, event.organizationId, projectId);
        return {
          organizationName: org.name,
          ...(actor === null ? {} : { actorName: actor }),
          subjectTitle: meeting.title,
          ...(project === null ? {} : { projectName: project }),
          when: formatUtc(meeting.startsAt),
          link: mailer.linkTo(`/${org.slug}/calendar/meetings/${meetingId}`),
        };
      },
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
  return people
    .filter((person) => isRole(person.role) && hasCapability(person.role, 'approval.decide'))
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

  const people = await listProjectClientPeople(tx, event.organizationId, projectId);
  return people
    .filter((person) => isRole(person.role) && hasCapability(person.role, 'approval.decide'))
    .filter((person) => picked.size === 0 || picked.has(person.userId))
    .map((person): PlannedNotice => ({
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
        };
      },
    }));
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

/** The planners by event type — the set `registry.ts` registers and the resume path re-plans. */
export const COLLABORATION_PLANNERS: Readonly<Record<string, NoticePlanner>> = {
  'message.created.v1': planMentionNotices,
  'document.comment_created.v1': planCommentNotices,
  'meeting.attendee_invited.v1': planMeetingInviteNotices,
  'project.member_added.v1': planProjectAddedNotices,
  'work_item.client_action_requested.v1': planClientActionNotices,
  'approval.requested.v1': planApprovalRequestedNotices,
  'client_request.message_posted.v1': planRequestMessageNotices,
};

// ─── Delivery ──────────────────────────────────────────────────────────────────

async function stageMail(input: {
  readonly event: ClaimedOutboxEvent;
  readonly tx: WorkerTransaction;
  readonly effects: Parameters<OutboxHandler>[2];
  readonly mailer: CollaborationMailer;
  readonly notice: PlannedNotice;
  readonly deferForQuietHours: boolean;
}): Promise<void> {
  const { event, tx, effects, mailer, notice } = input;
  const recipient = await findUsageMailRecipient(tx, event.organizationId, notice.recipientUserId);
  if (recipient === null || !recipient.emailEnabled) return; // Gone, or mail turned off.

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
  if (subject === null) return;
  const kind = notice.mailKind;
  effects.afterCommit(async () => {
    await mailer.deliver(kind, {
      ...subject,
      recipientEmail: recipient.email,
      recipientName: recipient.displayName,
      locale: recipient.locale,
    });
  });
}

/** The original-delivery handler for one event type: plan, then opt-out, in-app, email. */
export function createCollaborationNotices(
  planner: NoticePlanner,
  mailer: CollaborationMailer | null,
): OutboxHandler {
  const mails = mailer !== null && mailer.enabled ? mailer : null;
  return async (event, tx, effects) => {
    const notices = await planner(event, tx, mails);
    for (const notice of notices) {
      if (
        notice.optOutKind !== null &&
        notice.membershipId !== null &&
        !(await isNotificationKindEnabled(
          tx,
          event.organizationId,
          notice.membershipId,
          notice.optOutKind,
        ))
      ) {
        continue; // The person turned this kind off: neither inbox nor email.
      }
      if (notice.inApp !== null) {
        await insertNotification(tx, {
          organizationId: event.organizationId,
          recipientUserId: notice.recipientUserId,
          ...notice.inApp,
        });
      }
      if (mails !== null) {
        await stageMail({ event, tx, effects, mailer: mails, notice, deferForQuietHours: true });
      }
    }
  };
}

/**
 * The quiet-hours resume for the collaboration emails. Acts only on a resume row whose original
 * type has a planner here and which names its one recipient; no-ops otherwise, so it composes with
 * the other resume handlers on the one type. Re-plans the original event (re-checking access) and
 * mails that recipient alone, honouring a mail toggle or opt-out changed during the deferral.
 */
export function createCollaborationMailResume(mailer: CollaborationMailer): OutboxHandler {
  return async (event, tx, effects) => {
    if (!mailer.enabled) return;
    const envelope = decodeQuietHoursMailResume(event);
    if (envelope === null) return;
    const planner = COLLABORATION_PLANNERS[envelope.originalType];
    const recipientUserId = envelope.recipientUserId;
    if (planner === undefined || recipientUserId === undefined) return;

    const original = { ...event, type: envelope.originalType, payload: envelope.originalPayload };
    const notices = await planner(original, tx, mailer);
    for (const notice of notices) {
      if (notice.recipientUserId !== recipientUserId) continue;
      if (
        notice.optOutKind !== null &&
        notice.membershipId !== null &&
        !(await isNotificationKindEnabled(
          tx,
          event.organizationId,
          notice.membershipId,
          notice.optOutKind,
        ))
      ) {
        continue;
      }
      await stageMail({ event, tx, effects, mailer, notice, deferForQuietHours: false });
    }
  };
}
