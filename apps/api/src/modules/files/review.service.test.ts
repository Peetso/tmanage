import { describe, expect, it } from 'vitest';
import { assertSafeAuditMetadata } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow, ProjectRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import type { FileDownloadService, ResolvedFile } from './file-download.service.js';
import type { ReviewComment, ReviewCommentsRepository } from './review-comments.repository.js';
import type {
  MentionCandidateRow,
  MentionSearchInput,
  ReviewMentionCandidatesRepository,
  ReviewPersonRow,
} from './review-mention-candidates.repository.js';
import {
  DuplicateThreadNumberError,
  type InsertReviewThreadInput,
  type ListReviewThreadsInput,
  type ReviewThread,
  type ReviewThreadsRepository,
} from './review-threads.repository.js';
import { EDIT_WINDOW_MS, ReviewService, mentionedIds, parseAnchor } from './review.service.js';

/**
 * R4 slice 5 — proofing threads. In-memory fakes for the three repositories, the gate (the
 * download door's `resolve`) and the outbox; the real `authorize()` decides every write.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const ROOT = '00000000-0000-4000-8000-0000000000d1';
const V2 = '00000000-0000-4000-8000-0000000000d2';
const ROOT_VERSION = '00000000-0000-4000-8000-0000000000f1';
const V2_VERSION = '00000000-0000-4000-8000-0000000000f2';
const CLIENT_ORG = '00000000-0000-4000-8000-000000000201';
const STAFF_USER = '00000000-0000-4000-8000-0000000000c1';
const OTHER_STAFF_USER = '00000000-0000-4000-8000-0000000000c3';
const CLIENT_USER = '00000000-0000-4000-8000-0000000000c2';
const STRANGER = '00000000-0000-4000-8000-0000000000c9';
const STAFF_M = '00000000-0000-4000-8000-0000000000e1';
const OTHER_STAFF_M = '00000000-0000-4000-8000-0000000000e3';
const CLIENT_M = '00000000-0000-4000-8000-0000000000e2';

function principal(kind: 'staff' | 'other' | 'client' | 'guest' | 'viewer'): Principal {
  if (kind === 'client' || kind === 'viewer') {
    return {
      userId: CLIENT_USER,
      organizationId: ORG,
      kind: 'client',
      role: kind === 'viewer' ? 'client_viewer' : 'client_reviewer',
      membershipId: CLIENT_M,
      membershipStatus: 'active',
      clientOrganizationId: CLIENT_ORG,
      projectIds: [PROJECT],
      hasOrgWideScope: false,
    };
  }
  return {
    userId: kind === 'other' ? OTHER_STAFF_USER : STAFF_USER,
    organizationId: ORG,
    kind: 'internal',
    role: kind === 'guest' ? 'guest' : 'manager',
    membershipId: kind === 'other' ? OTHER_STAFF_M : STAFF_M,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function contextOf(who: Principal): TenantContext {
  return {
    organizationId: ORG,
    membershipId: who.membershipId,
    userId: who.userId,
    principalKind: who.kind,
  } as unknown as TenantContext;
}

const STAFF = principal('staff');
const OTHER = principal('other');
const CLIENT = principal('client');

interface World {
  readonly archived?: boolean;
  /** The opened asset is v2 of a chain whose root is ROOT. */
  readonly chained?: boolean;
  readonly assetAudience?: string;
  /** The gate refuses every file (as the door would for a stranger). */
  readonly unreachable?: boolean;
  /** Make the first N inserts lose the numbering race. */
  readonly lostRaces?: number;
}

function build(world: World = {}) {
  let clock = new Date('2026-11-01T10:00:00Z');
  const threads: ReviewThread[] = [];
  const comments: ReviewComment[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const refusals: string[] = [];
  let races = world.lostRaces ?? 0;
  let seq = 0;
  const nextId = () => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  };

  const project = {
    id: PROJECT,
    organizationId: ORG,
    archivedAt: world.archived ? new Date() : null,
  } as unknown as ProjectRow;
  const assetFor = (id: string): FileAssetRow =>
    ({
      id,
      organizationId: ORG,
      projectId: PROJECT,
      clientOrganizationId: null,
      audience: world.assetAudience ?? 'client_visible',
      purpose: 'attachment',
      status: 'ready',
      deletedAt: null,
    }) as unknown as FileAssetRow;
  const versionFor = (assetId: string): FileVersionRow =>
    ({ id: assetId === V2 ? V2_VERSION : ROOT_VERSION }) as unknown as FileVersionRow;

  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;

  const downloads = {
    resolve: async (_c: unknown, _p: unknown, fileId: string): Promise<ResolvedFile> => {
      if (world.unreachable || (fileId !== ROOT && fileId !== V2)) {
        refusals.push('file_not_found');
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      return {
        asset: assetFor(fileId),
        version: versionFor(fileId),
        project,
        access: { state: 'servable', scanStatus: 'clean' },
      } as unknown as ResolvedFile;
    },
    refuse: async (_c: unknown, code: string) => {
      refusals.push(code);
      return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, code);
    },
  } as unknown as FileDownloadService;

  const threadsRepo = {
    lockNextNumber: async (_r: unknown, _c: unknown, _t: string, subjectId: string) =>
      threads
        .filter((thread) => thread.subjectId === subjectId)
        .reduce((max, thread) => Math.max(max, thread.number), 0) + 1,
    insert: async (_r: unknown, _c: unknown, input: InsertReviewThreadInput) => {
      if (races > 0) {
        races -= 1;
        throw new DuplicateThreadNumberError();
      }
      const row = {
        id: nextId(),
        organizationId: ORG,
        ...input,
        carriedFromThreadId: input.carriedFromThreadId ?? null,
        status: 'open',
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: clock,
        updatedAt: clock,
        deletedAt: null,
        deletedByUserId: null,
        deletedReason: null,
        purgeAfter: null,
      } as unknown as ReviewThread;
      threads.push(row);
      return row;
    },
    findById: async (_r: unknown, _c: unknown, id: string) =>
      threads.find((thread) => thread.id === id) ?? null,
    listForSubject: async (_r: unknown, _c: unknown, input: ListReviewThreadsInput) =>
      threads
        .filter(
          (thread) =>
            thread.subjectId === input.subjectId &&
            input.audiences.includes(thread.audience) &&
            (input.fileVersionId === undefined || thread.fileVersionId === input.fileVersionId) &&
            (input.status === undefined || thread.status === input.status) &&
            thread.deletedAt === null,
        )
        .sort((a, b) => a.number - b.number),
    setResolved: async (_r: unknown, _c: unknown, id: string, by: string | null) => {
      const index = threads.findIndex((thread) => thread.id === id);
      const thread = threads[index];
      const target = by === null ? 'open' : 'resolved';
      if (!thread || thread.status === target) return false;
      threads[index] = {
        ...thread,
        status: target,
        resolvedByMembershipId: by,
        resolvedAt: by === null ? null : clock,
      };
      return true;
    },
    moveAnchor: async (
      _r: unknown,
      _c: unknown,
      id: string,
      place: { anchor: Record<string, unknown> | null; pageNo: number | null },
    ) => {
      const index = threads.findIndex((thread) => thread.id === id);
      const thread = threads[index];
      if (!thread) return false;
      threads[index] = { ...thread, anchor: place.anchor, pageNo: place.pageNo };
      return true;
    },
    softDelete: async (_r: unknown, _c: unknown, id: string) => {
      const index = threads.findIndex((thread) => thread.id === id);
      const thread = threads[index];
      if (!thread) return false;
      threads[index] = { ...thread, deletedAt: clock };
      return true;
    },
    assetOfVersion: async (_r: unknown, _c: unknown, versionId: string) =>
      versionId === V2_VERSION ? V2 : versionId === ROOT_VERSION ? ROOT : null,
  } as unknown as ReviewThreadsRepository;

  const commentsRepo = {
    insert: async (
      _r: unknown,
      context: TenantContext,
      input: { threadId: string; body: string; mentions: readonly string[] },
    ) => {
      const row = {
        id: nextId(),
        organizationId: ORG,
        threadId: input.threadId,
        body: input.body,
        mentions: input.mentions,
        createdByMembershipId: context.membershipId,
        createdAt: clock,
        editedAt: null,
        deletedAt: null,
      } as unknown as ReviewComment;
      comments.push(row);
      return row;
    },
    findById: async (_r: unknown, _c: unknown, id: string) =>
      comments.find((comment) => comment.id === id) ?? null,
    listForThreads: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      comments.filter((comment) => ids.includes(comment.threadId) && comment.deletedAt === null),
    editBody: async (
      _r: unknown,
      _c: unknown,
      id: string,
      body: string,
      mentions: readonly string[],
    ) => {
      const index = comments.findIndex((comment) => comment.id === id);
      const comment = comments[index];
      if (!comment) return false;
      comments[index] = { ...comment, body, mentions, editedAt: clock };
      return true;
    },
    softDelete: async (_r: unknown, _c: unknown, id: string) => {
      const index = comments.findIndex((comment) => comment.id === id);
      const comment = comments[index];
      if (!comment) return false;
      comments[index] = { ...comment, deletedAt: clock };
      return true;
    },
    countLive: async (_r: unknown, _c: unknown, threadId: string) =>
      comments.filter((comment) => comment.threadId === threadId && comment.deletedAt === null)
        .length,
  } as unknown as ReviewCommentsRepository;

  const everyone: MentionCandidateRow[] = [
    { userId: STAFF_USER, displayName: 'Mona Staff', kind: 'internal' },
    { userId: OTHER_STAFF_USER, displayName: 'Omar Staff', kind: 'internal' },
    { userId: CLIENT_USER, displayName: 'Carla Client', kind: 'client' },
  ];
  const searches: MentionSearchInput[] = [];
  const people = {
    search: async (_r: unknown, _c: unknown, input: MentionSearchInput) => {
      searches.push(input);
      return everyone.filter(
        (row) =>
          (row.kind === 'internal' ? input.includeStaff : input.includeClients) &&
          (input.userIds === undefined || input.userIds.includes(row.userId)) &&
          row.displayName.toLowerCase().includes(input.prefix.toLowerCase()),
      );
    },
    peopleByMembership: async (): Promise<ReviewPersonRow[]> => [
      { membershipId: STAFF_M, userId: STAFF_USER, displayName: 'Mona Staff', kind: 'internal' },
      {
        membershipId: OTHER_STAFF_M,
        userId: OTHER_STAFF_USER,
        displayName: 'Omar Staff',
        kind: 'internal',
      },
      { membershipId: CLIENT_M, userId: CLIENT_USER, displayName: 'Carla Client', kind: 'client' },
    ],
  } as unknown as ReviewMentionCandidatesRepository;

  const versions = {
    findInvolving: async (_r: unknown, _c: unknown, id: string) =>
      world.chained && (id === V2 || id === ROOT)
        ? { rootFileAssetId: ROOT, fileAssetId: V2 }
        : null,
  } as unknown as AttachmentVersionsRepository;

  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === PROJECT ? project : null),
  } as unknown as ProjectsRepository;
  const audit = {
    record: async (
      _r: unknown,
      _c: unknown,
      input: { action: string; metadata: Record<string, unknown> },
    ) => {
      // The real repository refuses content-like keys; so does the fake.
      assertSafeAuditMetadata(input.metadata);
      audits.push({ action: input.action, metadata: input.metadata });
      return {};
    },
  } as unknown as AuditService;
  const outbox = {
    append: async (
      _r: unknown,
      _c: unknown,
      input: { type: string; payload: Record<string, unknown> },
    ) => {
      events.push({ type: input.type, payload: input.payload });
    },
  } as unknown as OutboxEventsRepository;

  const service = new ReviewService(
    database,
    downloads,
    projects,
    audit,
    outbox,
    threadsRepo,
    commentsRepo,
    people,
    versions,
    () => clock,
  );
  return {
    service,
    threads,
    comments,
    audits,
    events,
    refusals,
    searches,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const pin = { anchorKind: 'pin', anchor: { x: 0.25, y: 0.5 }, body: 'Make the logo bigger' };

describe('ReviewService — threads', () => {
  it('opens a pin with its first comment, numbered 1, audited and announced', async () => {
    const { service, audits, events } = build();
    const view = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    expect(view.number).toBe(1);
    expect(view.anchorKind).toBe('pin');
    expect(view.anchor).toEqual({ x: 0.25, y: 0.5 });
    expect(view.audience).toBe('internal');
    expect(view.fileVersionId).toBe(ROOT_VERSION);
    expect(view.subjectId).toBe(ROOT);
    expect(view.comments).toHaveLength(1);
    expect(view.comments[0]?.body).toBe('Make the logo bigger');
    expect(view.createdBy).toEqual({
      membershipId: STAFF_M,
      displayName: 'Mona Staff',
      kind: 'internal',
    });
    expect(view.canResolve).toBe(true);
    expect(view.canMove).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(['review.thread_created']);
    expect(audits[0]?.metadata).not.toHaveProperty('body');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('review.thread_created.v1');
    expect(events[0]?.payload).toMatchObject({
      threadId: view.id,
      subjectType: 'file_asset',
      subjectId: ROOT,
      fileAssetId: ROOT,
      audience: 'internal',
      authorUserId: STAFF_USER,
      mentionedUserIds: [],
    });
    expect(JSON.stringify(events)).not.toContain('logo');
  });

  it('numbers monotonically per file across versions, on the root of the chain', async () => {
    const { service } = build({ chained: true });
    const a = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const b = await service.createThread(contextOf(STAFF), STAFF, 'internal', V2, pin);
    const c = await service.createThread(contextOf(OTHER), OTHER, 'internal', V2, pin);
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
    expect(b.subjectId).toBe(ROOT);
    expect(b.fileVersionId).toBe(V2_VERSION);
  });

  it('retries a lost numbering race (duplicate key) and then gives up with a 409', async () => {
    const won = build({ lostRaces: 2 });
    const view = await won.service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    expect(view.number).toBe(1);
    const lost = build({ lostRaces: 5 });
    const error = await refusal(
      lost.service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin),
    );
    expect(error.status).toBe(409);
    expect(lost.threads).toHaveLength(0);
  });

  it('keeps numbers after a delete (never reused)', async () => {
    const { service } = build();
    const first = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    await service.deleteComment(contextOf(STAFF), STAFF, 'internal', first.comments[0]?.id ?? '');
    const second = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    expect(second.number).toBe(2);
  });

  it('refuses a stale version and a file without one', async () => {
    const { service } = build();
    const error = await refusal(
      service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
        ...pin,
        versionId: V2_VERSION,
      }),
    );
    expect(error.status).toBe(409);
  });

  it('validates every anchor kind and computes a drawing box from its points', () => {
    expect(parseAnchor('box', { x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, 2)).toEqual({
      anchor: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
      pageNo: 2,
      timeMs: null,
    });
    expect(() => parseAnchor('box', { x: 0.8, y: 0, w: 0.5, h: 0.2 }, null)).toThrow(ApiError);
    expect(() => parseAnchor('pin', { x: 1.2, y: 0 }, null)).toThrow(ApiError);
    expect(() => parseAnchor('pin', { x: Number.NaN, y: 0 }, null)).toThrow(ApiError);
    expect(() => parseAnchor('pin', { x: 0, y: 0 }, 0)).toThrow(ApiError);
    const drawn = parseAnchor(
      'draw',
      {
        strokes: [
          {
            tool: 'arrow',
            color: '#FF0000',
            points: [
              [0.1, 0.2],
              [0.4, 0.6],
            ],
          },
        ],
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
      null,
    );
    expect(drawn.anchor).toEqual({
      strokes: [
        {
          tool: 'arrow',
          color: '#ff0000',
          points: [
            [0.1, 0.2],
            [0.4, 0.6],
          ],
        },
      ],
      bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    });
    expect(() =>
      parseAnchor('draw', { strokes: [{ tool: 'laser', color: '#000000', points: [] }] }, null),
    ).toThrow(ApiError);
    // R4 slice 7: the draw toolbar's line width is kept; a bad one is refused.
    expect(
      parseAnchor(
        'draw',
        { strokes: [{ tool: 'pen', color: '#090a09', width: 6, points: [[0.5, 0.5]] }] },
        3,
      ).anchor,
    ).toEqual({
      strokes: [{ tool: 'pen', color: '#090a09', width: 6, points: [[0.5, 0.5]] }],
      bbox: { x: 0.5, y: 0.5, w: 0, h: 0 },
    });
    for (const width of [0, 25, 4.5, '6']) {
      expect(() =>
        parseAnchor(
          'draw',
          { strokes: [{ tool: 'pen', color: '#090a09', width, points: [[0.5, 0.5]] }] },
          null,
        ),
      ).toThrow(ApiError);
    }
    expect(parseAnchor('time', { timeMs: 1500 }, null)).toEqual({
      anchor: { timeMs: 1500 },
      pageNo: null,
      timeMs: 1500,
    });
    expect(() => parseAnchor('time', { timeMs: 10, x: 0.5 }, null)).toThrow(ApiError);
    expect(parseAnchor('cell', { sheet: ' Budget ', cell: 'B12' }, null).anchor).toEqual({
      sheet: 'Budget',
      cell: 'B12',
    });
    expect(() => parseAnchor('cell', { sheet: 'S', cell: 'b0' }, null)).toThrow(ApiError);
    expect(parseAnchor('none', undefined, null).anchor).toBeNull();
  });

  it('refuses an empty body and an unknown anchor kind (400 / 422)', async () => {
    const { service } = build();
    expect(
      (
        await refusal(
          service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, { ...pin, body: ' ' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await refusal(
          service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
            ...pin,
            anchorKind: 'circle',
          }),
        )
      ).status,
    ).toBe(422);
  });
});

describe('ReviewService — audience and mentions', () => {
  it('refuses a client mentioned on an internal thread (422)', async () => {
    const { service, threads } = build();
    const error = await refusal(
      service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
        ...pin,
        audience: 'internal',
        body: `@${CLIENT_USER} please look`,
      }),
    );
    expect(error.status).toBe(422);
    expect(threads).toHaveLength(0);
  });

  it('makes the thread client-visible when staff mention a client without choosing', async () => {
    const { service, events } = build();
    const view = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
      ...pin,
      mentions: [CLIENT_USER],
    });
    expect(view.audience).toBe('client_visible');
    expect(events[0]?.payload['mentionedUserIds']).toEqual([CLIENT_USER]);
  });

  it('refuses a mention of somebody who is not on the project, and drops a self-mention', async () => {
    const { service } = build();
    const error = await refusal(
      service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
        ...pin,
        mentions: [STRANGER],
      }),
    );
    expect(error.status).toBe(422);
    expect(mentionedIds(`hi @${STAFF_USER} and @${OTHER_STAFF_USER}`, [], STAFF_USER)).toEqual([
      OTHER_STAFF_USER,
    ]);
    expect(() => mentionedIds('x', ['not-an-id'], STAFF_USER)).toThrow(ApiError);
  });

  it('refuses a client mention in a reply on an internal thread', async () => {
    const { service } = build();
    const thread = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const error = await refusal(
      service.addComment(contextOf(STAFF), STAFF, 'internal', thread.id, {
        body: 'see',
        mentions: [CLIENT_USER],
      }),
    );
    expect(error.status).toBe(422);
  });

  it('a client sees only client-visible threads of the version it opened', async () => {
    const { service } = build({ chained: true });
    await service.createThread(contextOf(STAFF), STAFF, 'internal', V2, pin);
    const shared = await service.createThread(contextOf(STAFF), STAFF, 'internal', V2, {
      ...pin,
      audience: 'client_visible',
    });
    await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
      ...pin,
      audience: 'client_visible',
    });
    const staffView = await service.listThreads(contextOf(STAFF), STAFF, 'internal', V2);
    expect(staffView.threads.map((t) => t.number)).toEqual([1, 2, 3]);
    const clientView = await service.listThreads(contextOf(CLIENT), CLIENT, 'client', V2, {
      versionId: ROOT_VERSION,
    });
    expect(clientView.threads.map((t) => t.id)).toEqual([shared.id]);
    expect(clientView.threads[0]?.number).toBe(2);
  });

  it('a client writes only client-visible threads and cannot open an internal one', async () => {
    const { service, refusals } = build();
    const own = await service.createThread(contextOf(CLIENT), CLIENT, 'client', ROOT, pin);
    expect(own.audience).toBe('client_visible');
    expect(
      (
        await refusal(
          service.createThread(contextOf(CLIENT), CLIENT, 'client', ROOT, {
            ...pin,
            audience: 'internal',
          }),
        )
      ).status,
    ).toBe(422);
    const internal = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const error = await refusal(
      service.addComment(contextOf(CLIENT), CLIENT, 'client', internal.id, { body: 'hi' }),
    );
    expect(error.status).toBe(404);
    expect(refusals).toContain('review_thread_internal');
  });

  it('studio routes refuse a client principal (door check)', async () => {
    const { service } = build();
    const error = await refusal(service.listThreads(contextOf(CLIENT), CLIENT, 'internal', ROOT));
    expect(error.status).toBe(403);
  });
});

describe('ReviewService — who may do what', () => {
  it('replies, then lists comments oldest first with author names', async () => {
    const { service, events, audits } = build();
    const thread = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const reply = await service.addComment(contextOf(OTHER), OTHER, 'internal', thread.id, {
      body: `Done @${STAFF_USER}`,
    });
    expect(reply.author.displayName).toBe('Omar Staff');
    expect(reply.mentions).toEqual([STAFF_USER]);
    expect(events.map((e) => e.type)).toEqual([
      'review.thread_created.v1',
      'review.comment_added.v1',
    ]);
    expect(audits.map((a) => a.action)).toContain('review.comment_added');
    const list = await service.listThreads(contextOf(STAFF), STAFF, 'internal', ROOT);
    expect(list.threads[0]?.comments.map((c) => c.body)).toEqual([
      'Make the logo bigger',
      `Done @${STAFF_USER}`,
    ]);
    expect(list.threads[0]?.comments[1]?.canEdit).toBe(false);
  });

  it('edits own comment inside fifteen minutes only, never another person’s', async () => {
    const { service, advance } = build();
    const thread = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const commentId = thread.comments[0]?.id ?? '';
    const edited = await service.editComment(contextOf(STAFF), STAFF, 'internal', commentId, {
      body: 'Make the logo much bigger',
    });
    expect(edited.body).toBe('Make the logo much bigger');
    expect(edited.editedAt).not.toBeNull();
    expect(
      (
        await refusal(
          service.editComment(contextOf(OTHER), OTHER, 'internal', commentId, { body: 'x' }),
        )
      ).status,
    ).toBe(403);
    advance(EDIT_WINDOW_MS + 1);
    expect(
      (
        await refusal(
          service.editComment(contextOf(STAFF), STAFF, 'internal', commentId, { body: 'late' }),
        )
      ).status,
    ).toBe(409);
  });

  it('deletes own comment only; the last one takes the thread; absent is a no-op', async () => {
    const { service, threads } = build();
    const thread = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const reply = await service.addComment(contextOf(OTHER), OTHER, 'internal', thread.id, {
      body: 'ok',
    });
    expect(
      (await refusal(service.deleteComment(contextOf(STAFF), STAFF, 'internal', reply.id))).status,
    ).toBe(403);
    await service.deleteComment(contextOf(OTHER), OTHER, 'internal', reply.id);
    expect(threads[0]?.deletedAt).toBeNull();
    await service.deleteComment(contextOf(STAFF), STAFF, 'internal', thread.comments[0]?.id ?? '');
    expect(threads[0]?.deletedAt).not.toBeNull();
    await service.deleteComment(contextOf(STAFF), STAFF, 'internal', thread.comments[0]?.id ?? '');
    await service.deleteComment(contextOf(STAFF), STAFF, 'internal', STRANGER);
    expect((await service.listThreads(contextOf(STAFF), STAFF, 'internal', ROOT)).threads).toEqual(
      [],
    );
  });

  it('staff resolve any thread; a client only its own; a second resolve is quiet', async () => {
    const { service, events } = build();
    const staffThread = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, {
      ...pin,
      audience: 'client_visible',
    });
    const clientThread = await service.createThread(contextOf(CLIENT), CLIENT, 'client', ROOT, pin);
    const resolved = await service.setResolved(
      contextOf(OTHER),
      OTHER,
      'internal',
      clientThread.id,
      true,
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy?.displayName).toBe('Omar Staff');
    await service.setResolved(contextOf(OTHER), OTHER, 'internal', clientThread.id, true);
    expect(events.filter((e) => e.type === 'review.thread_resolved.v1')).toHaveLength(1);
    expect(
      (
        await refusal(
          service.setResolved(contextOf(CLIENT), CLIENT, 'client', staffThread.id, true),
        )
      ).status,
    ).toBe(403);
    const reopened = await service.setResolved(
      contextOf(CLIENT),
      CLIENT,
      'client',
      clientThread.id,
      false,
    );
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedBy).toBeNull();
  });

  it('moves own pin on the same version only', async () => {
    const { service } = build();
    const thread = await service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin);
    const moved = await service.moveThread(contextOf(STAFF), STAFF, 'internal', thread.id, {
      anchor: { x: 0.9, y: 0.1 },
    });
    expect(moved.anchor).toEqual({ x: 0.9, y: 0.1 });
    expect(
      (
        await refusal(
          service.moveThread(contextOf(OTHER), OTHER, 'internal', thread.id, {
            anchor: { x: 0.1, y: 0.1 },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await refusal(
          service.moveThread(contextOf(STAFF), STAFF, 'internal', thread.id, {
            versionId: V2_VERSION,
            anchor: { x: 0.1, y: 0.1 },
          }),
        )
      ).status,
    ).toBe(422);
  });

  it('archived project and a read-only role: threads read, nothing written', async () => {
    const archived = build({ archived: true });
    expect(
      (await refusal(archived.service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin)))
        .status,
    ).toBe(403);
    expect(
      (await archived.service.listThreads(contextOf(STAFF), STAFF, 'internal', ROOT)).threads,
    ).toEqual([]);

    const guest = principal('guest');
    const plain = build();
    expect(
      (await refusal(plain.service.createThread(contextOf(guest), guest, 'internal', ROOT, pin)))
        .status,
    ).toBe(403);
    const viewer = principal('viewer');
    expect(
      (await refusal(plain.service.createThread(contextOf(viewer), viewer, 'client', ROOT, pin)))
        .status,
    ).toBe(403);
  });

  it('an unreachable file is the one 404, before anything is written', async () => {
    const { service, threads } = build({ unreachable: true });
    expect(
      (await refusal(service.createThread(contextOf(STAFF), STAFF, 'internal', ROOT, pin))).status,
    ).toBe(404);
    expect(threads).toHaveLength(0);
    expect(
      (
        await refusal(
          service.addComment(contextOf(STAFF), STAFF, 'internal', STRANGER, { body: 'x' }),
        )
      ).status,
    ).toBe(404);
  });
});

describe('ReviewService — mention candidates', () => {
  it('lists staff, adds client contacts only for a client-visible comment, never yourself', async () => {
    const { service, searches } = build();
    const internal = await service.mentionCandidates(
      contextOf(STAFF),
      STAFF,
      'internal',
      PROJECT,
      {},
    );
    expect(internal.candidates.map((c) => c.displayName)).toEqual(['Omar Staff']);
    expect(internal.candidates[0]?.mention).toBe(`@${OTHER_STAFF_USER}`);
    const shared = await service.mentionCandidates(contextOf(STAFF), STAFF, 'internal', PROJECT, {
      audience: 'client_visible',
      q: '@ca',
    });
    expect(shared.candidates.map((c) => c.kind)).toEqual(['client']);
    expect(searches[1]?.prefix).toBe('ca');
  });

  it('a client sees staff and only its own organization’s contacts', async () => {
    const { service, searches } = build();
    await service.mentionCandidates(contextOf(CLIENT), CLIENT, 'client', PROJECT, {});
    expect(searches[0]).toMatchObject({ includeClients: true, clientOrganizationId: CLIENT_ORG });
  });

  it('an unknown project is a 404 and a bad limit a 400', async () => {
    const { service } = build();
    expect(
      (await refusal(service.mentionCandidates(contextOf(STAFF), STAFF, 'internal', STRANGER, {})))
        .status,
    ).toBe(404);
    expect(
      (
        await refusal(
          service.mentionCandidates(contextOf(STAFF), STAFF, 'internal', PROJECT, { limit: '99' }),
        )
      ).status,
    ).toBe(400);
  });
});
