import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { createCollaborationNotices } from './collaboration-notices.js';
import {
  planReviewCommentNotices,
  planReviewDecisionNotices,
  planReviewResolvedNotices,
  reviewRecipientOf,
  reviewViewerPath,
  versionNoOf,
} from './review-notices.js';
import { fileWithVersion } from '../notifications/review-email.js';
import { createWorkerOutboxHandlers } from './registry.js';
import {
  CollaborationMailer,
  composeCollaborationEmail,
} from '../notifications/collaboration-mailer.js';
import type { CollaborationEmailFacts } from '../notifications/collaboration-mailer.js';

/**
 * R4 slice 12 — who hears about a comment, a resolved thread and a decision on a file under
 * review, over a fake transaction that answers each statement by what it reads. The real SQL is the
 * database suites' business; this proves the recipient rules, the dedupe key and the email copy.
 */

const ORG = 'org-1';
const ROOT = 'file-root';

function event(type: string, payload: Record<string, unknown>, id = 'event-1'): ClaimedOutboxEvent {
  return {
    id,
    organizationId: ORG,
    type,
    schemaVersion: 1,
    aggregateType: 'review_thread',
    aggregateId: 'thread-1',
    payload,
    correlationId: null,
    occurredAt: new Date('2026-11-01T00:00:00.000Z'),
    attempts: 1,
  } as ClaimedOutboxEvent;
}

interface World {
  readonly audience: 'internal' | 'client_visible';
  /** Internal members: user id → on the project. */
  readonly members: Readonly<Record<string, { onProject: boolean; role?: string }>>;
  /** Client people on the project. */
  readonly clients: readonly { user_id: string; role: string }[];
  readonly participants: readonly string[];
  readonly owner: string;
  readonly threadGone?: boolean;
}

function fakeTx(world: World): {
  tx: WorkerTransaction;
  writes: { sql: string; params: readonly unknown[] }[];
} {
  const writes: { sql: string; params: readonly unknown[] }[] = [];
  const tx = {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      if (/^\s*INSERT/u.test(sql)) {
        writes.push({ sql, params });
        return { affectedRows: 1 };
      }
      // Every review read names the organization first.
      if (sql.includes('FROM review_threads t\n      WHERE')) {
        expect(params[0]).toBe(ORG);
        if (world.threadGone === true) return [];
        return [
          {
            number: 4,
            audience: world.audience,
            subject_type: 'file_asset',
            subject_id: ROOT,
            project_id: 'proj-1',
          },
        ];
      }
      if (
        sql.includes('FROM review_comments c') ||
        sql.includes('FROM review_threads t\n       JOIN')
      ) {
        expect(params[0]).toBe(ORG);
        return world.participants.map((user_id) => ({ user_id, first_at: new Date() }));
      }
      if (sql.includes('FROM file_assets f')) {
        expect(params[0]).toBe(ORG);
        return [{ name: 'Homepage Concept', owner_user_id: world.owner, project_id: 'proj-1' }];
      }
      if (sql.includes('FROM memberships m')) {
        const userId = String(params[2]);
        const found = world.members[userId];
        if (found === undefined) return [];
        return [
          {
            id: `membership-${userId}`,
            role: found.role ?? 'member',
            has_org_wide_scope: 0,
            on_project: found.onProject ? 1 : 0,
          },
        ];
      }
      if (sql.includes('FROM client_memberships cm')) return world.clients;
      if (sql.includes('FROM organizations')) return [{ slug: 'atlas', name: 'Atlas Studio' }];
      if (sql.includes('FROM projects')) return [{ name: 'Atlas Rebrand' }];
      if (sql.includes('FROM users')) {
        return [{ display_name: params[0] === 'maya' ? 'Maya' : 'Someone' }];
      }
      return [];
    },
  } as WorkerTransaction;
  return { tx, writes };
}

const commentPayload = (overrides: Record<string, unknown> = {}) => ({
  commentId: 'comment-9',
  threadId: 'thread-1',
  subjectType: 'file_asset',
  subjectId: ROOT,
  fileAssetId: 'file-v2',
  projectId: 'proj-1',
  audience: 'internal',
  authorUserId: 'maya',
  mentionedUserIds: [],
  ...overrides,
});

describe('reviewRecipientOf', () => {
  const reach = {
    membershipId: 'm',
    role: 'member' as const,
    hasOrgWideScope: false,
    onProject: true,
  };
  it('tells a team member who reaches the project, never one off it', () => {
    expect(
      reviewRecipientOf({ userId: 'a', reach, audience: 'internal', clientPeople: [] }),
    ).toEqual({
      kind: 'internal',
      userId: 'a',
      membershipId: 'm',
    });
    expect(
      reviewRecipientOf({
        userId: 'a',
        reach: { ...reach, onProject: false },
        audience: 'internal',
        clientPeople: [],
      }),
    ).toBeNull();
  });

  it('tells a client person only on a client-visible thread, and only while on the project', () => {
    const clientPeople = [{ userId: 'rami', role: 'client_reviewer' }];
    expect(
      reviewRecipientOf({ userId: 'rami', reach: null, audience: 'internal', clientPeople }),
    ).toBeNull();
    expect(
      reviewRecipientOf({ userId: 'rami', reach: null, audience: 'client_visible', clientPeople }),
    ).toEqual({ kind: 'client', userId: 'rami' });
    expect(
      reviewRecipientOf({ userId: 'gone', reach: null, audience: 'client_visible', clientPeople }),
    ).toBeNull();
  });
});

describe('planReviewCommentNotices', () => {
  it('tells the mentioned first, then participants and the uploader, never the author', async () => {
    const { tx } = fakeTx({
      audience: 'internal',
      members: {
        maya: { onProject: true },
        omar: { onProject: true },
        lina: { onProject: true },
        sam: { onProject: true },
      },
      clients: [],
      participants: ['maya', 'omar'],
      owner: 'lina',
    });
    const notices = await planReviewCommentNotices(
      event(
        'review.comment_added.v1',
        commentPayload({ mentionedUserIds: ['sam', 'omar', 'maya'] }),
      ),
      tx,
      null,
    );
    expect(notices.map((n) => [n.recipientUserId, n.mailKind, n.optOutKind])).toEqual([
      ['sam', 'review_mention', 'mention'],
      ['omar', 'review_mention', 'mention'],
      ['lina', 'review_reply', 'file'],
    ]);
    expect(notices[0]?.inApp).toEqual({
      type: 'review.mentioned.v1',
      objectType: 'file_asset',
      objectId: ROOT,
      dedupeKey: 'review:thread-1:comment-9',
    });
    // A reply on an existing thread is said as a reply (R4 Batch F).
    expect(notices[2]?.inApp?.type).toBe('review.replied.v1');
  });

  it('tells no client on an internal thread, even a participant', async () => {
    const { tx } = fakeTx({
      audience: 'internal',
      members: { maya: { onProject: true } },
      clients: [{ user_id: 'rami', role: 'client_reviewer' }],
      participants: ['rami'],
      owner: 'maya',
    });
    const notices = await planReviewCommentNotices(
      event('review.comment_added.v1', commentPayload({ authorUserId: 'omar' })),
      tx,
      null,
    );
    expect(notices.map((n) => n.recipientUserId)).toEqual(['maya']);
  });

  it('on a client-visible thread tells the client participant, with the portal link and the studio as sender', async () => {
    const { tx } = fakeTx({
      audience: 'client_visible',
      members: { maya: { onProject: true }, lina: { onProject: true } },
      clients: [{ user_id: 'rami', role: 'client_reviewer' }],
      participants: ['rami', 'maya'],
      owner: 'lina',
    });
    const mailer = new CollaborationMailer(
      { send: () => Promise.resolve('sent' as const) },
      'https://app.example',
    );
    const notices = await planReviewCommentNotices(
      event('review.comment_added.v1', commentPayload({ audience: 'client_visible' })),
      tx,
      mailer,
    );
    expect(notices.map((n) => [n.recipientUserId, n.membershipId])).toEqual([
      ['rami', null],
      ['lina', 'membership-lina'],
    ]);
    const clientMail = await notices[0]?.mail();
    expect(clientMail).toMatchObject({
      organizationName: 'Atlas Studio',
      subjectTitle: 'Homepage Concept',
      pinNumber: 4,
      portal: true,
      link: 'https://app.example/atlas/portal/files/file-root?thread=thread-1',
    });
    expect(clientMail?.actorName).toBeUndefined(); // A client hears "Atlas Studio", not Maya.
    const staffMail = await notices[1]?.mail();
    expect(staffMail).toMatchObject({
      actorName: 'Maya',
      portal: false,
      link: 'https://app.example/atlas/files/file-root?thread=thread-1',
    });
  });

  it('a client not on the project any more is not told', async () => {
    const { tx } = fakeTx({
      audience: 'client_visible',
      members: { maya: { onProject: true } },
      clients: [],
      participants: ['rami'],
      owner: 'maya',
    });
    const notices = await planReviewCommentNotices(
      event(
        'review.comment_added.v1',
        commentPayload({ authorUserId: 'omar', audience: 'client_visible' }),
      ),
      tx,
      null,
    );
    expect(notices.map((n) => n.recipientUserId)).toEqual(['maya']);
  });

  it('a deleted thread or a Figma subject tells nobody', async () => {
    const world: World = {
      audience: 'internal',
      members: { lina: { onProject: true } },
      clients: [],
      participants: [],
      owner: 'lina',
      threadGone: true,
    };
    expect(
      await planReviewCommentNotices(
        event('review.comment_added.v1', commentPayload()),
        fakeTx(world).tx,
        null,
      ),
    ).toEqual([]);
    expect(
      await planReviewCommentNotices(
        event('review.thread_created.v1', commentPayload({ subjectType: 'figma_frame' })),
        fakeTx({ ...world, threadGone: false }).tx,
        null,
      ),
    ).toEqual([]);
  });

  it('a redelivered event writes the same dedupe key, so the inbox row is not doubled', async () => {
    const world: World = {
      audience: 'internal',
      members: { lina: { onProject: true } },
      clients: [],
      participants: [],
      owner: 'lina',
    };
    const { tx, writes } = fakeTx(world);
    const handler = createCollaborationNotices(planReviewCommentNotices, null);
    const effects = { afterCommit: () => undefined } as unknown as Parameters<typeof handler>[2];
    await handler(event('review.thread_created.v1', commentPayload()), tx, effects);
    await handler(event('review.thread_created.v1', commentPayload()), tx, effects);
    const inserts = writes.filter((write) => write.sql.includes('notifications'));
    expect(inserts).toHaveLength(2);
    expect(new Set(inserts.map((write) => String(write.params[6])))).toEqual(
      new Set(['review:thread-1:comment-9']),
    );
    expect(inserts[0]?.sql).toContain('ON DUPLICATE KEY');
  });
});

describe('planReviewResolvedNotices', () => {
  it('tells participants and the uploader in the inbox only, never the resolver', async () => {
    const { tx } = fakeTx({
      audience: 'internal',
      members: { maya: { onProject: true }, lina: { onProject: true } },
      clients: [],
      participants: ['maya', 'omar'],
      owner: 'lina',
    });
    const notices = await planReviewResolvedNotices(
      event('review.thread_resolved.v1', {
        threadId: 'thread-1',
        subjectType: 'file_asset',
        subjectId: ROOT,
        projectId: 'proj-1',
        audience: 'internal',
        resolved: true,
        byUserId: 'omar',
      }),
      tx,
      null,
    );
    expect(notices.map((n) => n.recipientUserId)).toEqual(['maya', 'lina']);
    expect(notices.every((n) => n.mailKind === null)).toBe(true);
    expect(notices[0]?.inApp?.type).toBe('review.thread_resolved.v1');
  });
});

describe('planReviewDecisionNotices', () => {
  it('tells the uploaders and the team who replied, never a client or the decider', async () => {
    const { tx } = fakeTx({
      audience: 'internal',
      members: {
        maya: { onProject: true },
        lina: { onProject: true },
        youssef: { onProject: true },
      },
      clients: [{ user_id: 'rami', role: 'client_reviewer' }],
      participants: ['rami', 'maya', 'youssef'],
      owner: 'lina',
    });
    const notices = await planReviewDecisionNotices(
      event('review.decision_recorded.v1', {
        decisionId: 'dec-1',
        rootFileAssetId: ROOT,
        fileAssetId: 'file-v2',
        projectId: 'proj-1',
        decision: 'approved',
        byUserId: 'youssef',
        principalKind: 'internal',
      }),
      tx,
      null,
    );
    expect(notices.map((n) => n.recipientUserId)).toEqual(['lina', 'maya']);
    expect(notices[0]).toMatchObject({
      mailKind: 'review_decided',
      optOutKind: 'file',
      inApp: { type: 'review.approved.v1', objectId: ROOT, dedupeKey: 'review.decision:dec-1' },
    });
  });
});

describe('registry', () => {
  it('registers the four review events', () => {
    const handlers = createWorkerOutboxHandlers();
    for (const type of [
      'review.thread_created.v1',
      'review.comment_added.v1',
      'review.thread_resolved.v1',
      'review.decision_recorded.v1',
    ]) {
      expect(handlers[type], type).toBeTypeOf('function');
    }
  });

  it('builds the studio and portal viewer paths', () => {
    expect(reviewViewerPath('atlas', 'f1', false, 't1')).toBe('/atlas/files/f1?thread=t1');
    expect(reviewViewerPath('atlas', 'f1', true)).toBe('/atlas/portal/files/f1');
  });
});

describe('review emails (EN + AR, studio + portal)', () => {
  const base: CollaborationEmailFacts = {
    recipientEmail: 'lina@atlas.example',
    recipientName: 'Lina',
    organizationName: 'Atlas Studio',
    actorName: 'Maya',
    subjectTitle: 'Homepage Concept',
    projectName: 'Atlas Rebrand',
    pinNumber: 4,
    link: 'https://app.example/atlas/files/file-root?thread=thread-1',
  };
  // A client hears the studio's name: the portal facts carry no actor.
  const { actorName: _actor, ...studioless } = base;
  const cases: readonly [
    string,
    Parameters<typeof composeCollaborationEmail>[0],
    CollaborationEmailFacts,
  ][] = [
    ['comment · studio · en', 'review_comment', base],
    ['comment · studio · ar', 'review_comment', { ...base, locale: 'ar-EG' }],
    [
      'comment · portal · en',
      'review_comment',
      {
        ...studioless,
        portal: true,
        link: 'https://app.example/atlas/portal/files/file-root?thread=thread-1',
      } as CollaborationEmailFacts,
    ],
    ['comment · portal · ar', 'review_comment', { ...studioless, portal: true, locale: 'ar' }],
    ['reply · portal · ar', 'review_reply', { ...studioless, portal: true, locale: 'ar' }],
    ['mention · studio · en', 'review_mention', base],
    ['mention · studio · ar', 'review_mention', { ...base, locale: 'ar' }],
    [
      'decided approved · en',
      'review_decided',
      { ...base, actorName: 'Youssef', decision: 'approved' },
    ],
    [
      'decided changes · ar',
      'review_decided',
      { ...base, actorName: 'Youssef', decision: 'changes_requested', locale: 'ar' },
    ],
  ];

  for (const [name, kind, facts] of cases) {
    it(name, () => {
      const message = composeCollaborationEmail(kind, facts);
      expect({ subject: message.subject, text: message.text }).toMatchSnapshot();
      expect(message.html).toContain(facts.link.replaceAll('&', '&amp;'));
      expect(message.html).toContain(
        facts.locale?.startsWith('ar') === true ? 'dir="rtl"' : 'dir="ltr"',
      );
    });
  }

  it('names the version as V-51 draws it; an event without one renders as before', () => {
    expect(fileWithVersion('Homepage Concept.png', 2)).toBe('Homepage Concept v2.png');
    expect(fileWithVersion('Homepage Concept v2.png', 2)).toBe('Homepage Concept v2.png');
    expect(fileWithVersion('Brief', 3)).toBe('Brief v3');
    expect(fileWithVersion('Brief.pdf', undefined)).toBe('Brief.pdf');
    expect([versionNoOf({ versionNo: 2 }), versionNoOf({}), versionNoOf({ versionNo: 0 })]).toEqual(
      [2, undefined, undefined],
    );
    const message = composeCollaborationEmail('review_comment', { ...base, versionNumber: 2 });
    expect(message.subject).toBe('Maya commented on Homepage Concept v2');
  });

  it('never quotes what anybody wrote and escapes what people typed', () => {
    const message = composeCollaborationEmail('review_comment', {
      ...base,
      subjectTitle: 'Logo <script>alert(1)</script>',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});
