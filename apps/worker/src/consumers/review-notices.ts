import { isClientRole } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  findDisplayName,
  findInternalReach,
  findOrganizationFacts,
  findProjectName,
  listProjectClientPeople,
} from '../common/database/collaboration-store.js';
import type { ClientActionCandidate } from '../common/database/collaboration-store.js';
import {
  findReviewFileFacts,
  findReviewThreadFacts,
  listReviewSubjectParticipants,
  listReviewThreadParticipants,
} from '../common/database/review-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { CollaborationEmailFacts } from '../notifications/collaboration-mailer.js';
import { mayBeTold } from './collaboration-notices.js';
import type { NoticePlanner, PlannedNotice } from './collaboration-notices.js';

/**
 * R4 slice 12 — who hears about a comment, a resolved thread or a decision in the proofing viewer.
 *
 * | Event                         | Who is told                                                     | In-app | Email |
 * |-------------------------------|-----------------------------------------------------------------|--------|-------|
 * | `review.thread_created.v1`    | the people mentioned, then the file's uploader                  | yes    | yes   |
 * | `review.comment_added.v1`     | the people mentioned, the thread's participants, the uploader   | yes    | yes   |
 * | `review.thread_resolved.v1`   | the thread's participants and the uploader                      | yes    | no    |
 * | `review.decision_recorded.v1` | the uploaders of the root and the version, the team who replied | yes    | yes   |
 *
 * Never the person who did it. Every recipient is re-checked from the current rows:
 *
 * - a **team member** needs an active membership whose role holds `file.download` and reaches the
 *   project (org-wide scope or a project seat);
 * - a **client person** is told only about a `client_visible` thread, only while their client
 *   membership is active and unexpired and the project is still shared with their company, and only
 *   when they are already part of the thread — mentioned on it, or the author of a live reply. A
 *   participant has already reached the file through the portal; a mention of a client is refused
 *   by the API on an internal thread. A decision tells the team only.
 *
 * The comment text never travels: the email names who, which file and which pin, and links the
 * viewer with `?thread=` (the portal viewer for a client). Emails to a client name the studio, not
 * the team member who wrote, as the request-message emails do.
 *
 * One dedupe key per (comment, recipient) — `review:<threadId>:<commentId>` against the
 * notifications table's (organization, recipient, dedupe_key) unique key — so a redelivered event
 * writes nothing new, and a person both mentioned and participating gets one notice, the mention.
 */

type MailSubject = Omit<CollaborationEmailFacts, 'recipientEmail' | 'recipientName' | 'locale'>;

/** The in-app types the inbox renders for a file under review. */
export const REVIEW_NOTIFICATION_TYPES = [
  'review.comment_added.v1',
  'review.replied.v1',
  'review.mentioned.v1',
  'review.thread_resolved.v1',
  'review.thread_reopened.v1',
  'review.approved.v1',
  'review.changes_requested.v1',
] as const;

/** The inbox object a review notice is filed under: the root file of the version chain. */
export const REVIEW_OBJECT_TYPE = 'file_asset';

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

/**
 * R4 Batch F follow-up — the version number the api now puts on a review event, so the email can
 * say "v<N>". Optional: an event written before it (or a malformed value) renders without one.
 */
export function versionNoOf(payload: Record<string, unknown>): number | undefined {
  const value = payload['versionNo'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function idList(payload: Record<string, unknown>, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

type Recipient =
  | { readonly kind: 'internal'; readonly userId: string; readonly membershipId: string }
  | { readonly kind: 'client'; readonly userId: string };

/**
 * Is this person still allowed to hear about the file? A team member by the reach rule; a client
 * person only on a client-visible thread, from the project's current client people. Pure over its
 * inputs once the reach and the client list are read, so the unit suite enumerates it.
 */
export function reviewRecipientOf(input: {
  readonly userId: string;
  readonly reach: Parameters<typeof mayBeTold>[0];
  readonly audience: 'internal' | 'client_visible';
  readonly clientPeople: readonly ClientActionCandidate[];
}): Recipient | null {
  const { userId, reach, audience, clientPeople } = input;
  if (reach !== null) {
    return mayBeTold(reach, 'file.download')
      ? { kind: 'internal', userId, membershipId: reach.membershipId }
      : null;
  }
  if (audience !== 'client_visible') return null;
  const person = clientPeople.find((candidate) => candidate.userId === userId);
  if (person === undefined || !isClientRole(person.role)) return null;
  return { kind: 'client', userId };
}

/** Resolves recipients for one event, reading the client list at most once. */
function recipientResolver(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
  audience: 'internal' | 'client_visible',
): (userId: string) => Promise<Recipient | null> {
  let clientPeople: readonly ClientActionCandidate[] | null = null;
  return async (userId) => {
    const reach = await findInternalReach(tx, organizationId, userId, projectId);
    if (reach === null && audience === 'client_visible' && clientPeople === null) {
      clientPeople = await listProjectClientPeople(tx, organizationId, projectId);
    }
    return reviewRecipientOf({ userId, reach, audience, clientPeople: clientPeople ?? [] });
  };
}

/** The studio and portal links to the viewer, opened on one thread when there is one. */
export function reviewViewerPath(
  organizationSlug: string,
  fileAssetId: string,
  portal: boolean,
  threadId?: string,
): string {
  const base = portal
    ? `/${organizationSlug}/portal/files/${fileAssetId}`
    : `/${organizationSlug}/files/${fileAssetId}`;
  return threadId === undefined ? base : `${base}?thread=${encodeURIComponent(threadId)}`;
}

/**
 * `review.thread_created.v1` and `review.comment_added.v1` — one payload shape, one planner. The
 * people mentioned first (a mention notice), then the thread's participants and the file's
 * uploader (a comment notice).
 */
export const planReviewCommentNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  if (raw['subjectType'] !== 'file_asset') return []; // Figma frames arrive with their own slice.
  const threadId = stringField(raw, 'threadId', event.id);
  const commentId = stringField(raw, 'commentId', event.id);
  const authorUserId = stringField(raw, 'authorUserId', event.id);
  const versionNo = versionNoOf(raw);

  const thread = await findReviewThreadFacts(tx, event.organizationId, threadId);
  if (thread === null || thread.subjectType !== 'file_asset') return []; // Gone.
  const file = await findReviewFileFacts(tx, event.organizationId, thread.subjectId);
  if (file === null) return [];

  const candidates: { readonly userId: string; readonly mentioned: boolean }[] = [];
  const seen = new Set<string>([authorUserId]);
  const consider = (userId: string, mentioned: boolean): void => {
    if (seen.has(userId)) return;
    seen.add(userId);
    candidates.push({ userId, mentioned });
  };
  for (const userId of idList(raw, 'mentionedUserIds')) consider(userId, true);
  for (const userId of await listReviewThreadParticipants(tx, event.organizationId, threadId)) {
    consider(userId, false);
  }
  consider(file.ownerUserId, false);

  const resolve = recipientResolver(tx, event.organizationId, thread.projectId, thread.audience);
  let authorIsTeam: boolean | null = null;
  const mail = (portal: boolean) => async (): Promise<MailSubject | null> => {
    if (mailer === null) return null;
    const org = await findOrganizationFacts(tx, event.organizationId);
    if (org === null) return null;
    if (portal && authorIsTeam === null) {
      authorIsTeam =
        (await findInternalReach(tx, event.organizationId, authorUserId, thread.projectId)) !==
        null;
    }
    // A client is told "the studio" for a team member's words, a colleague's name otherwise.
    const actor = portal && authorIsTeam === true ? null : await findDisplayName(tx, authorUserId);
    const project = await findProjectName(tx, event.organizationId, thread.projectId);
    return {
      organizationName: org.name,
      ...(actor === null ? {} : { actorName: actor }),
      subjectTitle: file.name,
      ...(project === null ? {} : { projectName: project }),
      pinNumber: thread.number,
      ...(versionNo === undefined ? {} : { versionNumber: versionNo }),
      portal,
      link: mailer.linkTo(reviewViewerPath(org.slug, thread.subjectId, portal, threadId)),
    };
  };

  // A new thread is a comment; `review.comment_added.v1` is a reply on an existing thread, and
  // the inbox card and email say so (R4 Batch F, V-50 / V-51).
  const reply = event.type === 'review.comment_added.v1';
  const notices: PlannedNotice[] = [];
  for (const candidate of candidates) {
    const recipient = await resolve(candidate.userId);
    if (recipient === null) continue;
    const portal = recipient.kind === 'client';
    notices.push({
      recipientUserId: recipient.userId,
      optOutKind: portal ? null : candidate.mentioned ? 'mention' : 'file',
      membershipId: recipient.kind === 'internal' ? recipient.membershipId : null,
      inApp: {
        type: candidate.mentioned
          ? 'review.mentioned.v1'
          : reply
            ? 'review.replied.v1'
            : 'review.comment_added.v1',
        objectType: REVIEW_OBJECT_TYPE,
        objectId: thread.subjectId,
        dedupeKey: `review:${threadId}:${commentId}`,
      },
      mailKind: candidate.mentioned ? 'review_mention' : reply ? 'review_reply' : 'review_comment',
      mail: mail(portal),
    });
  }
  return notices;
};

/**
 * `review.thread_resolved.v1` — a thread was resolved or reopened: its participants and the file's
 * uploader see it in the inbox. No email: a resolved comment is not something to interrupt for.
 */
export const planReviewResolvedNotices: NoticePlanner = async (event, tx) => {
  const raw = payloadOf(event);
  if (raw['subjectType'] !== 'file_asset') return [];
  const threadId = stringField(raw, 'threadId', event.id);
  const byUserId = stringField(raw, 'byUserId', event.id);
  const resolved = raw['resolved'] === true;

  const thread = await findReviewThreadFacts(tx, event.organizationId, threadId);
  if (thread === null || thread.subjectType !== 'file_asset') return [];
  const file = await findReviewFileFacts(tx, event.organizationId, thread.subjectId);
  if (file === null) return [];

  const people = [
    ...(await listReviewThreadParticipants(tx, event.organizationId, threadId)),
    file.ownerUserId,
  ];
  const resolve = recipientResolver(tx, event.organizationId, thread.projectId, thread.audience);
  const notices: PlannedNotice[] = [];
  const seen = new Set<string>([byUserId]);
  for (const userId of people) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const recipient = await resolve(userId);
    if (recipient === null) continue;
    notices.push({
      recipientUserId: recipient.userId,
      optOutKind: recipient.kind === 'internal' ? 'file' : null,
      membershipId: recipient.kind === 'internal' ? recipient.membershipId : null,
      inApp: {
        type: resolved ? 'review.thread_resolved.v1' : 'review.thread_reopened.v1',
        objectType: REVIEW_OBJECT_TYPE,
        objectId: thread.subjectId,
        // Each resolve or reopen is news once; a redelivery is not.
        dedupeKey: `review.resolved:${event.id}`,
      },
      mailKind: null,
      mail: () => Promise.resolve(null),
    });
  }
  return notices;
};

/**
 * `review.decision_recorded.v1` — a version of a plain file was approved, or changes were asked
 * for. The team is told: whoever uploaded the root file and this version, and every team member who
 * replied on the file's threads. Never a client, never the person who decided.
 */
export const planReviewDecisionNotices: NoticePlanner = async (event, tx, mailer) => {
  const raw = payloadOf(event);
  const decisionId = stringField(raw, 'decisionId', event.id);
  const rootFileAssetId = stringField(raw, 'rootFileAssetId', event.id);
  const fileAssetId = stringField(raw, 'fileAssetId', event.id);
  const projectId = stringField(raw, 'projectId', event.id);
  const byUserId = stringField(raw, 'byUserId', event.id);
  const decision = raw['decision'] === 'approved' ? 'approved' : 'changes_requested';
  const versionNo = versionNoOf(raw);

  const root = await findReviewFileFacts(tx, event.organizationId, rootFileAssetId);
  if (root === null) return [];
  const version =
    fileAssetId === rootFileAssetId
      ? root
      : await findReviewFileFacts(tx, event.organizationId, fileAssetId);

  const people = [
    root.ownerUserId,
    ...(version === null ? [] : [version.ownerUserId]),
    ...(await listReviewSubjectParticipants(tx, event.organizationId, rootFileAssetId)),
  ];
  // `internal`: a decision is the team's news, so no client person passes the rule.
  const resolve = recipientResolver(tx, event.organizationId, projectId, 'internal');

  const mail = async (): Promise<MailSubject | null> => {
    if (mailer === null) return null;
    const org = await findOrganizationFacts(tx, event.organizationId);
    if (org === null) return null;
    const actor = await findDisplayName(tx, byUserId);
    const project = await findProjectName(tx, event.organizationId, projectId);
    return {
      organizationName: org.name,
      ...(actor === null ? {} : { actorName: actor }),
      subjectTitle: (version ?? root).name,
      ...(project === null ? {} : { projectName: project }),
      decision,
      ...(versionNo === undefined ? {} : { versionNumber: versionNo }),
      link: mailer.linkTo(reviewViewerPath(org.slug, fileAssetId, false)),
    };
  };

  const notices: PlannedNotice[] = [];
  const seen = new Set<string>([byUserId]);
  for (const userId of people) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const recipient = await resolve(userId);
    if (recipient === null || recipient.kind !== 'internal') continue;
    notices.push({
      recipientUserId: recipient.userId,
      optOutKind: 'file',
      membershipId: recipient.membershipId,
      inApp: {
        type: decision === 'approved' ? 'review.approved.v1' : 'review.changes_requested.v1',
        objectType: REVIEW_OBJECT_TYPE,
        objectId: rootFileAssetId,
        dedupeKey: `review.decision:${decisionId}`,
      },
      mailKind: 'review_decided',
      mail,
    });
  }
  return notices;
};

/** The review planners by event type — registered in `registry.ts` and re-planned on resume. */
export const REVIEW_PLANNERS: Readonly<Record<string, NoticePlanner>> = {
  'review.thread_created.v1': planReviewCommentNotices,
  'review.comment_added.v1': planReviewCommentNotices,
  'review.thread_resolved.v1': planReviewResolvedNotices,
  'review.decision_recorded.v1': planReviewDecisionNotices,
};
