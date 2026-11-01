import { authorize, extractMentionedUserIds } from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { AttachmentVersionsRepository, chainVersionNo } from './attachment-versions.repository.js';
import { assertDoor } from './file-download.service.js';
import type { FileDownloadService, ResolvedFile } from './file-download.service.js';
import { ReviewCommentsRepository } from './review-comments.repository.js';
import type { ReviewComment } from './review-comments.repository.js';
import { ReviewMentionCandidatesRepository } from './review-mention-candidates.repository.js';
import type {
  MentionCandidateRow,
  ReviewPersonKind,
  ReviewPersonRow,
} from './review-mention-candidates.repository.js';
import {
  REVIEW_ANCHOR_KINDS,
  ReviewThreadsRepository,
  isRetryableNumberRace,
} from './review-threads.repository.js';
import type {
  ReviewAnchorKind,
  ReviewAudience,
  ReviewSubjectType,
  ReviewThread,
  ReviewThreadStatus,
} from './review-threads.repository.js';

/**
 * R4 slice 5 — the proofing viewer's threads: pins, boxes, drawings, moments and cells on a file,
 * with their comments (SPEC R4 §3.3, §3.4).
 *
 * ## One gate: the download door's
 *
 * Every route reaches its file through {@link FileDownloadService.resolve} — the row, purpose,
 * client relation, `authorize(file.download)` decision the download door makes — so a thread is
 * readable exactly when its file is, and every refusal is the door's one 404 (audited under the
 * action being attempted). Thread- and comment-only routes find the file through the version the
 * thread was drawn on. A write also needs `file.upload` on the file and a project that is not
 * archived (read-only viewer, lifecycle rule 6).
 *
 * ## The subject is the root of the version chain
 *
 * A thread hangs on the ROOT asset of the attachment version chain, so pin #3 stays #3 on v2, and
 * records the version it was drawn on. Numbers are taken under a lock and a lost race (the unique
 * key, or the deadlock two first pins can meet) is retried a few times.
 *
 * ## Audience
 *
 * Staff see every thread; a client principal sees only `client_visible` threads drawn on the
 * version they opened, and every thread it writes is `client_visible`. Staff choose: `internal`
 * by default, `client_visible` when they say so or when they mention a client contact without
 * choosing. Mentioning a client on an `internal` thread is refused (422) — the client would be
 * told of a conversation they cannot read. The audience never changes after creation (trigger).
 *
 * ## Who may do what
 *
 * Reply: anyone who may write. Edit: own comment, within {@link EDIT_WINDOW_MS}. Delete: own
 * comment (soft delete; the last comment takes the thread with it). Resolve / reopen: staff any
 * thread, a client its own. Move a pin: own thread, same version, same anchor kind.
 */

export const REVIEW_SERVICE = Symbol.for('tmanage.ReviewService');

/** Comments may be edited by their author for fifteen minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;

/** The longest comment the service accepts (`TEXT` holds 65 535 bytes; Arabic is 2 bytes a letter). */
export const MAX_REVIEW_BODY = 10_000;

/** How many times a lost numbering race is retried before the caller is asked to try again. */
const NUMBER_ATTEMPTS = 5;

const MAX_MENTIONS = 50;
const MAX_STROKES = 50;
const MAX_POINTS_PER_STROKE = 2000;
const MAX_POINTS_TOTAL = 10_000;
const MAX_STROKE_WIDTH = 24;
const MAX_PAGE = 100_000;
const MAX_TIME_MS = 2_147_483_647;

const VIEW_ACTION: AuditAction = 'file_preview.viewed';
const CREATE_ACTION: AuditAction = 'review.thread_created';
const REPLY_ACTION: AuditAction = 'review.comment_added';
const RESOLVE_ACTION: AuditAction = 'review.thread_resolved';

export type ReviewDoor = 'internal' | 'client';

// ─── Views ─────────────────────────────────────────────────────────────────

/** A person on a thread. `displayName` is `null` when the membership no longer exists. */
export interface ReviewPersonView {
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly kind: ReviewPersonKind;
}

export interface ReviewCommentView {
  readonly id: string;
  readonly threadId: string;
  readonly body: string;
  /** The user ids the comment mentions. */
  readonly mentions: readonly string[];
  readonly author: ReviewPersonView;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface ReviewThreadView {
  readonly id: string;
  /** The visible pin number, per file (all versions). */
  readonly number: number;
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  readonly fileVersionId: string | null;
  readonly anchorKind: ReviewAnchorKind;
  /** Numbers relative to the page or frame (0..1); see `0268_review_threads.sql`. */
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly pageNo: number | null;
  readonly timeMs: number | null;
  readonly audience: ReviewAudience;
  readonly status: ReviewThreadStatus;
  readonly createdBy: ReviewPersonView;
  readonly createdAt: string;
  readonly resolvedBy: ReviewPersonView | null;
  readonly resolvedAt: string | null;
  readonly carriedFromThreadId: string | null;
  readonly comments: readonly ReviewCommentView[];
  readonly canResolve: boolean;
  readonly canMove: boolean;
}

export interface ReviewThreadListView {
  readonly threads: readonly ReviewThreadView[];
}

export interface ReviewMentionCandidateView {
  readonly userId: string;
  readonly displayName: string;
  readonly kind: ReviewPersonKind;
  /** The token to insert in the text: `@<userId>`. */
  readonly mention: string;
}

export interface ReviewMentionCandidatesView {
  readonly candidates: readonly ReviewMentionCandidateView[];
}

// ─── Inputs ────────────────────────────────────────────────────────────────

export interface ListThreadsQuery {
  readonly versionId?: string | undefined;
  readonly status?: string | undefined;
}

export interface CreateThreadInput {
  readonly versionId?: unknown;
  readonly anchorKind?: unknown;
  readonly anchor?: unknown;
  readonly pageNo?: unknown;
  readonly timeMs?: unknown;
  readonly audience?: unknown;
  readonly body?: unknown;
  readonly mentions?: unknown;
}

export interface CommentInput {
  readonly body?: unknown;
  readonly mentions?: unknown;
}

export interface MoveThreadInput {
  readonly versionId?: unknown;
  readonly anchor?: unknown;
  readonly pageNo?: unknown;
  readonly timeMs?: unknown;
}

export interface MentionCandidatesQuery {
  readonly q?: string | undefined;
  readonly audience?: string | undefined;
  readonly limit?: string | undefined;
}

// ─── Anchors ───────────────────────────────────────────────────────────────

export interface ParsedAnchor {
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly pageNo: number | null;
  readonly timeMs: number | null;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(422, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function badRequest(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/** A coordinate relative to the page: a finite number from 0 to 1, kept to six decimals. */
function unit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(field, 'must be a number from 0 to 1');
  }
  return Math.round(value * 1e6) / 1e6;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function optionalInt(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(field, `must be a whole number from ${min} to ${max}`);
  }
  return value;
}

const STROKE_TOOLS = new Set(['pen', 'arrow', 'rect']);
const COLOR = /^#[0-9a-f]{6}$/i;
const CELL = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

function parseStrokes(raw: unknown): {
  strokes: { tool: string; color: string; width?: number; points: [number, number][] }[];
  bbox: { x: number; y: number; w: number; h: number };
} {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STROKES) {
    throw invalid('anchor.strokes', `must list 1 to ${MAX_STROKES} strokes`);
  }
  let total = 0;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  const strokes = raw.map((entry, index) => {
    const stroke = record(entry, `anchor.strokes[${index}]`);
    const tool = stroke['tool'];
    if (typeof tool !== 'string' || !STROKE_TOOLS.has(tool)) {
      throw invalid(`anchor.strokes[${index}].tool`, 'must be pen, arrow or rect');
    }
    const color = stroke['color'];
    if (typeof color !== 'string' || !COLOR.test(color)) {
      throw invalid(`anchor.strokes[${index}].color`, 'must be a #rrggbb colour');
    }
    const pointsRaw = stroke['points'];
    if (
      !Array.isArray(pointsRaw) ||
      pointsRaw.length < (tool === 'pen' ? 1 : 2) ||
      pointsRaw.length > MAX_POINTS_PER_STROKE
    ) {
      throw invalid(`anchor.strokes[${index}].points`, 'has too few or too many points');
    }
    total += pointsRaw.length;
    if (total > MAX_POINTS_TOTAL) throw invalid('anchor.strokes', 'has too many points');
    const points = pointsRaw.map((point, p) => {
      if (!Array.isArray(point) || point.length !== 2) {
        throw invalid(`anchor.strokes[${index}].points[${p}]`, 'must be [x, y]');
      }
      const x = unit(point[0], `anchor.strokes[${index}].points[${p}]`);
      const y = unit(point[1], `anchor.strokes[${index}].points[${p}]`);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      return [x, y] as [number, number];
    });
    // Line width in screen pixels (the draw toolbar's 4 / 6 / 9); optional for older drawings.
    const widthRaw = stroke['width'];
    if (widthRaw === undefined || widthRaw === null) {
      return { tool, color: color.toLowerCase(), points };
    }
    if (
      typeof widthRaw !== 'number' ||
      !Number.isInteger(widthRaw) ||
      widthRaw < 1 ||
      widthRaw > MAX_STROKE_WIDTH
    ) {
      throw invalid(
        `anchor.strokes[${index}].width`,
        `must be a whole number from 1 to ${MAX_STROKE_WIDTH}`,
      );
    }
    return { tool, color: color.toLowerCase(), width: widthRaw, points };
  });
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    strokes,
    // Computed here from the points, never taken from the body.
    bbox: { x: minX, y: minY, w: round(maxX - minX), h: round(maxY - minY) },
  };
}

/**
 * Validate a thread's place. Coordinates are relative (0..1) to the page or frame, never pixels,
 * so a pin stays put at every screen size and in either reading direction.
 */
export function parseAnchor(kind: ReviewAnchorKind, raw: unknown, pageRaw: unknown): ParsedAnchor {
  const pageNo = optionalInt(pageRaw, 'pageNo', 1, MAX_PAGE);
  switch (kind) {
    case 'none':
      if (raw !== undefined && raw !== null) throw invalid('anchor', 'must be empty');
      return { anchor: null, pageNo, timeMs: null };
    case 'pin': {
      const body = record(raw, 'anchor');
      return {
        anchor: { x: unit(body['x'], 'anchor.x'), y: unit(body['y'], 'anchor.y') },
        pageNo,
        timeMs: null,
      };
    }
    case 'box': {
      const body = record(raw, 'anchor');
      const x = unit(body['x'], 'anchor.x');
      const y = unit(body['y'], 'anchor.y');
      const w = unit(body['w'], 'anchor.w');
      const h = unit(body['h'], 'anchor.h');
      if (w === 0 || h === 0) throw invalid('anchor', 'a box needs a width and a height');
      if (x + w > 1.000001 || y + h > 1.000001) throw invalid('anchor', 'must stay on the page');
      return { anchor: { x, y, w, h }, pageNo, timeMs: null };
    }
    case 'draw': {
      const body = record(raw, 'anchor');
      return { anchor: parseStrokes(body['strokes']), pageNo, timeMs: null };
    }
    case 'time': {
      const body = record(raw, 'anchor');
      const timeMs = optionalInt(body['timeMs'], 'anchor.timeMs', 0, MAX_TIME_MS);
      if (timeMs === null) throw invalid('anchor.timeMs', 'is required');
      const hasX = body['x'] !== undefined && body['x'] !== null;
      const hasY = body['y'] !== undefined && body['y'] !== null;
      if (hasX !== hasY) throw invalid('anchor', 'x and y go together');
      const anchor: Record<string, unknown> = { timeMs };
      if (hasX) {
        anchor['x'] = unit(body['x'], 'anchor.x');
        anchor['y'] = unit(body['y'], 'anchor.y');
      }
      return { anchor, pageNo: null, timeMs };
    }
    case 'cell': {
      const body = record(raw, 'anchor');
      const sheet = body['sheet'];
      const cell = body['cell'];
      if (typeof sheet !== 'string' || sheet.trim() === '' || sheet.length > 100) {
        throw invalid('anchor.sheet', 'must be a sheet name');
      }
      if (typeof cell !== 'string' || !CELL.test(cell)) {
        throw invalid('anchor.cell', 'must be a cell like B12');
      }
      return { anchor: { sheet: sheet.trim(), cell }, pageNo: null, timeMs: null };
    }
  }
}

function anchorKindOf(raw: unknown): ReviewAnchorKind {
  if (raw === undefined || raw === null) return 'none';
  if (typeof raw !== 'string' || !(REVIEW_ANCHOR_KINDS as readonly string[]).includes(raw)) {
    throw invalid('anchorKind', 'must be pin, box, draw, time, cell or none');
  }
  return raw as ReviewAnchorKind;
}

function requiredBody(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw badRequest('body', 'must not be empty');
  const body = raw.trim();
  if (body.length > MAX_REVIEW_BODY) {
    throw badRequest('body', `must be ${MAX_REVIEW_BODY} characters or fewer`);
  }
  return body;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids a comment names: the picker's list plus every `@<userId>` token in the text. */
export function mentionedIds(body: string, raw: unknown, selfUserId: string): readonly string[] {
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw badRequest('mentions', 'must be a list of user ids');
  }
  const listed = (raw ?? []) as unknown[];
  const ids: string[] = [];
  for (const entry of listed) {
    if (typeof entry !== 'string' || !UUID.test(entry)) {
      throw badRequest('mentions', 'must be a list of user ids');
    }
    const id = entry.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  for (const id of extractMentionedUserIds(body)) if (!ids.includes(id)) ids.push(id);
  const others = ids.filter((id) => id !== selfUserId.toLowerCase());
  if (others.length > MAX_MENTIONS) throw badRequest('mentions', 'names too many people');
  return others;
}

// ─── Service ───────────────────────────────────────────────────────────────

/** What a write needs to know about the subject a thread hangs on. */
interface WriteGate {
  readonly canWrite: boolean;
  readonly archived: boolean;
  /** The file the caller opened (outbox payloads), `null` for a Figma frame. */
  readonly fileAssetId: string | null;
}

interface Gate extends WriteGate {
  readonly resolved: ResolvedFile;
}

/**
 * R4 slice 13. A Figma frame a thread may hang on (`subject_type = 'figma_frame'`), as the Figma
 * module resolved it for this caller: its project, its link's audience and whether the project is
 * archived.
 */
export interface ReviewFrameSubject {
  readonly frameId: string;
  readonly organizationId: string;
  readonly projectId: string;
  /** The link's audience: a client reaches only frames of client-visible links. */
  readonly audience: ReviewAudience;
  readonly archived: boolean;
}

/** R4 slice 13. The Figma module's read decision on a frame; `null` is the one 404. */
export interface ReviewFrameGate {
  resolveFrame(
    context: TenantContext,
    principal: Principal,
    frameId: string,
  ): Promise<ReviewFrameSubject | null>;
}

export class ReviewService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly downloads: FileDownloadService,
    private readonly projects: ProjectsRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxEventsRepository | null,
    private readonly threads: ReviewThreadsRepository = new ReviewThreadsRepository(),
    private readonly comments: ReviewCommentsRepository = new ReviewCommentsRepository(),
    private readonly people: ReviewMentionCandidatesRepository = new ReviewMentionCandidatesRepository(),
    private readonly versions: AttachmentVersionsRepository = new AttachmentVersionsRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly frames: ReviewFrameGate | null = null,
  ) {}

  /** `GET files/:fileId/review/threads?versionId=&status=` */
  async listThreads(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    fileId: string,
    query: ListThreadsQuery = {},
  ): Promise<ReviewThreadListView> {
    assertDoor(principal, door);
    const gate = await this.gate(context, principal, fileId, VIEW_ACTION);
    const status = statusFilter(query.status);
    const client = principal.kind === 'client';
    if (query.versionId !== undefined && !UUID.test(query.versionId)) {
      throw badRequest('versionId', 'must be a version id');
    }
    // A client reads only the client-visible threads drawn on the version it opened.
    const versionId = client ? (gate.resolved.version?.id ?? null) : (query.versionId ?? undefined);
    if (versionId === null) return { threads: [] };
    return this.database.read(context, async (runner) => {
      const subjectId = await this.subjectOf(runner, context, gate.resolved.asset);
      const rows = await this.threads.listForSubject(runner, context, {
        subjectType: 'file_asset',
        subjectId,
        fileVersionId: versionId,
        status,
        audiences: client ? ['client_visible'] : ['internal', 'client_visible'],
      });
      return { threads: await this.views(runner, context, principal, gate.canWrite, rows) };
    });
  }

  /** `POST files/:fileId/review/threads` — a new pin (or box, drawing …) with its first comment. */
  async createThread(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    fileId: string,
    input: CreateThreadInput,
  ): Promise<ReviewThreadView> {
    assertDoor(principal, door);
    const body = requiredBody(input.body);
    const anchorKind = anchorKindOf(input.anchorKind);
    const place = parseAnchor(anchorKind, input.anchor, input.pageNo);
    const requestedAudience = audienceOf(input.audience);
    const mentions = mentionedIds(body, input.mentions, principal.userId);

    const gate = await this.gate(context, principal, fileId, CREATE_ACTION);
    this.requireWrite(gate);
    const { asset, version } = gate.resolved;
    if (version === null) {
      throw new ApiError(409, 'conflict', 'This file is not ready for comments yet');
    }
    if (
      input.versionId !== undefined &&
      input.versionId !== null &&
      input.versionId !== version.id
    ) {
      throw new ApiError(409, 'conflict', 'A newer version of this file was uploaded. Reload');
    }

    const client = principal.kind === 'client';
    const named = await this.database.read(context, (runner) =>
      this.checkMentions(runner, context, principal, asset.projectId, mentions),
    );
    const namesClient = named.some((row) => row.kind === 'client');
    let audience: ReviewAudience;
    if (client) {
      if (requestedAudience === 'internal') throw invalid('audience', 'must be client_visible');
      audience = 'client_visible';
    } else if (requestedAudience === null) {
      audience = namesClient ? 'client_visible' : 'internal';
    } else {
      audience = requestedAudience;
    }
    if (audience === 'internal' && namesClient) {
      throw invalid('mentions', 'a client cannot be mentioned on an internal comment');
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.database.transaction(context, async (tx) => {
          const link = await this.versions.findInvolving(tx, context, asset.id);
          const subjectId = link ? link.rootFileAssetId : asset.id;
          const number = await this.threads.lockNextNumber(tx, context, 'file_asset', subjectId);
          const thread = await this.threads.insert(tx, context, {
            projectId: asset.projectId,
            subjectType: 'file_asset',
            subjectId,
            fileVersionId: version.id,
            anchorKind,
            anchor: place.anchor,
            pageNo: place.pageNo,
            timeMs: place.timeMs,
            number,
            audience,
            createdByMembershipId: context.membershipId,
          });
          const comment = await this.comments.insert(tx, context, {
            threadId: thread.id,
            body,
            mentions,
            createdByMembershipId: context.membershipId,
          });
          await this.audit.record(tx, context, {
            action: CREATE_ACTION,
            objectId: thread.id,
            result: 'allowed',
            actorUserId: principal.userId,
            metadata: {
              project_id: asset.projectId,
              file_asset_id: asset.id,
              root_file_asset_id: subjectId,
              audience,
              anchor_kind: anchorKind,
              mention_count: mentions.length,
              principal_kind: principal.kind,
            },
          });
          await this.outbox?.append(tx, context, {
            type: 'review.thread_created.v1',
            aggregateId: thread.id,
            payload: {
              threadId: thread.id,
              commentId: comment.id,
              subjectType: 'file_asset',
              subjectId,
              fileAssetId: asset.id,
              projectId: asset.projectId,
              audience,
              authorUserId: principal.userId,
              mentionedUserIds: mentions,
              // R4 Batch F follow-up: the emails say "v<N>"; the worker has no version table.
              versionNo: chainVersionNo(link, asset.id),
            },
          });
          return thread;
        });
        return await this.database.read(context, async (runner) => {
          const [view] = await this.views(runner, context, principal, true, [created]);
          if (!view) throw new Error('review thread vanished after create');
          return view;
        });
      } catch (error) {
        if (isRetryableNumberRace(error) && attempt < NUMBER_ATTEMPTS) {
          // A short, jittered pause so racing writers do not collide again in step.
          await new Promise((done) =>
            setTimeout(done, 5 + Math.floor(Math.random() * 20 * attempt)),
          );
          continue;
        }
        if (isRetryableNumberRace(error)) {
          throw new ApiError(409, 'conflict', 'Someone else just added a comment. Try again');
        }
        throw error;
      }
    }
  }

  /** `POST review/threads/:threadId/comments` — a reply. */
  async addComment(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    threadId: string,
    input: CommentInput,
  ): Promise<ReviewCommentView> {
    assertDoor(principal, door);
    const body = requiredBody(input.body);
    const mentions = mentionedIds(body, input.mentions, principal.userId);
    const { thread, gate } = await this.threadGate(context, principal, threadId, REPLY_ACTION);
    this.requireWrite(gate);
    const named = await this.database.read(context, (runner) =>
      this.checkMentions(runner, context, principal, thread.projectId, mentions),
    );
    if (thread.audience === 'internal' && named.some((row) => row.kind === 'client')) {
      throw invalid('mentions', 'a client cannot be mentioned on an internal comment');
    }
    const comment = await this.database.transaction(context, async (tx) => {
      // R4 Batch F follow-up: the version the thread is drawn on, for the notice's "v<N>".
      const versionNo =
        gate.fileAssetId === null
          ? undefined
          : chainVersionNo(
              await this.versions.findInvolving(tx, context, gate.fileAssetId),
              gate.fileAssetId,
            );
      const row = await this.comments.insert(tx, context, {
        threadId: thread.id,
        body,
        mentions,
        createdByMembershipId: context.membershipId,
      });
      await this.audit.record(tx, context, {
        action: REPLY_ACTION,
        objectId: thread.id,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          project_id: thread.projectId,
          reply_id: row.id,
          audience: thread.audience,
          mention_count: mentions.length,
          principal_kind: principal.kind,
        },
      });
      await this.outbox?.append(tx, context, {
        type: 'review.comment_added.v1',
        aggregateId: thread.id,
        payload: {
          commentId: row.id,
          threadId: thread.id,
          subjectType: thread.subjectType,
          subjectId: thread.subjectId,
          fileAssetId: gate.fileAssetId,
          projectId: thread.projectId,
          audience: thread.audience,
          authorUserId: principal.userId,
          mentionedUserIds: mentions,
          ...(versionNo === undefined ? {} : { versionNo }),
        },
      });
      return row;
    });
    return this.database.read(context, async (runner) => {
      const people = await this.peopleMap(runner, context, [comment.createdByMembershipId]);
      return this.commentView(context, comment, people, true);
    });
  }

  /** `PATCH review/comments/:commentId` — own comment, within the edit window. */
  async editComment(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    commentId: string,
    input: CommentInput,
  ): Promise<ReviewCommentView> {
    assertDoor(principal, door);
    const body = requiredBody(input.body);
    const mentions = mentionedIds(body, input.mentions, principal.userId);
    const comment = await this.liveComment(context, commentId);
    const { thread, gate } = await this.threadGate(
      context,
      principal,
      comment.threadId,
      REPLY_ACTION,
    );
    this.requireWrite(gate);
    if (comment.createdByMembershipId !== context.membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_comment_author');
    }
    if (!this.withinEditWindow(comment)) {
      throw new ApiError(409, 'conflict', 'This comment can no longer be edited');
    }
    const named = await this.database.read(context, (runner) =>
      this.checkMentions(runner, context, principal, thread.projectId, mentions),
    );
    if (thread.audience === 'internal' && named.some((row) => row.kind === 'client')) {
      throw invalid('mentions', 'a client cannot be mentioned on an internal comment');
    }
    await this.database.transaction(context, (tx) =>
      this.comments.editBody(tx, context, comment.id, body, mentions),
    );
    return this.database.read(context, async (runner) => {
      const fresh = await this.comments.findById(runner, context, comment.id);
      if (!fresh) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const people = await this.peopleMap(runner, context, [fresh.createdByMembershipId]);
      return this.commentView(context, fresh, people, true);
    });
  }

  /** `DELETE review/comments/:commentId` — own comment. Absent is a no-op. */
  async deleteComment(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    commentId: string,
  ): Promise<void> {
    assertDoor(principal, door);
    const comment = await this.database.read(context, (runner) =>
      this.comments.findById(runner, context, commentId),
    );
    if (!comment || comment.deletedAt !== null) return;
    const { gate } = await this.threadGate(context, principal, comment.threadId, REPLY_ACTION);
    this.requireWrite(gate);
    if (comment.createdByMembershipId !== context.membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_comment_author');
    }
    await this.database.transaction(context, async (tx) => {
      await this.comments.softDelete(tx, context, comment.id);
      // The last comment takes its pin with it; the number is not reused.
      if ((await this.comments.countLive(tx, context, comment.threadId)) === 0) {
        await this.threads.softDelete(tx, context, comment.threadId);
      }
    });
  }

  /** `POST review/threads/:threadId/resolve` and `…/unresolve`. */
  async setResolved(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    threadId: string,
    resolved: boolean,
  ): Promise<ReviewThreadView> {
    assertDoor(principal, door);
    const { thread, gate } = await this.threadGate(context, principal, threadId, RESOLVE_ACTION);
    this.requireWrite(gate);
    if (!this.mayResolve(context, principal, thread)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_thread_author');
    }
    await this.database.transaction(context, async (tx) => {
      const moved = await this.threads.setResolved(
        tx,
        context,
        thread.id,
        resolved ? context.membershipId : null,
      );
      if (!moved) return;
      await this.audit.record(tx, context, {
        action: RESOLVE_ACTION,
        objectId: thread.id,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          project_id: thread.projectId,
          resolved,
          audience: thread.audience,
          principal_kind: principal.kind,
        },
      });
      await this.outbox?.append(tx, context, {
        type: 'review.thread_resolved.v1',
        aggregateId: thread.id,
        payload: {
          threadId: thread.id,
          subjectType: thread.subjectType,
          subjectId: thread.subjectId,
          projectId: thread.projectId,
          audience: thread.audience,
          resolved,
          byUserId: principal.userId,
        },
      });
    });
    return this.freshView(context, principal, thread.id, gate.canWrite);
  }

  /** `PATCH review/threads/:threadId` — move own pin on the same version. */
  async moveThread(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    threadId: string,
    input: MoveThreadInput,
  ): Promise<ReviewThreadView> {
    assertDoor(principal, door);
    const { thread, gate } = await this.threadGate(context, principal, threadId, REPLY_ACTION);
    this.requireWrite(gate);
    if (thread.createdByMembershipId !== context.membershipId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_thread_author');
    }
    if (thread.anchorKind === 'none') throw invalid('anchor', 'this comment has no place to move');
    if (
      input.versionId !== undefined &&
      input.versionId !== null &&
      input.versionId !== thread.fileVersionId
    ) {
      throw invalid('versionId', 'a pin moves only on the version it was drawn on');
    }
    const place = parseAnchor(thread.anchorKind, input.anchor, input.pageNo);
    await this.database.transaction(context, (tx) =>
      this.threads.moveAnchor(tx, context, thread.id, place),
    );
    return this.freshView(context, principal, thread.id, gate.canWrite);
  }

  /** `GET projects/:projectId/review/mention-candidates?q=&audience=` */
  async mentionCandidates(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    projectId: string,
    query: MentionCandidatesQuery,
  ): Promise<ReviewMentionCandidatesView> {
    assertDoor(principal, door);
    const prefix = (query.q ?? '').trim().replace(/^@/, '');
    if (prefix.length > 100) throw badRequest('q', 'must be 100 characters or fewer');
    const limit = query.limit === undefined ? 10 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
      throw badRequest('limit', 'must be a whole number from 1 to 25');
    }
    const audience = query.audience === undefined ? null : audienceOf(query.audience);
    const client = principal.kind === 'client';
    const rows = await this.database.read(context, async (runner) => {
      const project = await this.projects.findById(runner, context, projectId);
      const capability: Capability = client ? 'client_projection.read' : 'work.read';
      const allowed =
        project !== null &&
        authorize({
          principal,
          capability,
          resource: {
            organizationId: project.organizationId,
            projectId: project.id,
            audience: client ? 'client_visible' : 'internal',
            clientOrganizationId: client ? principal.clientOrganizationId : null,
            lifecycle: project.archivedAt === null ? 'active' : 'archived',
          },
        }).allowed;
      if (!allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return this.people.search(runner, context, {
        projectId,
        prefix,
        includeStaff: true,
        // Staff see client contacts only for a client-visible comment; a client always sees
        // its own colleagues (everything it writes is client-visible).
        includeClients: client || audience === 'client_visible',
        clientOrganizationId: client ? principal.clientOrganizationId : null,
        limit,
      });
    });
    const seen = new Set<string>([principal.userId]);
    const candidates: ReviewMentionCandidateView[] = [];
    for (const row of [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      candidates.push({
        userId: row.userId,
        displayName: row.displayName,
        kind: row.kind,
        mention: `@${row.userId}`,
      });
    }
    return { candidates: candidates.slice(0, limit) };
  }

  // ─── Figma frames (R4 slice 13) ──────────────────────────────────────────

  /** `GET figma/frames/:frameId/review/threads?status=` — a frame's threads with comments. */
  async listFrameThreads(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    frameId: string,
    query: Pick<ListThreadsQuery, 'status'> = {},
  ): Promise<ReviewThreadListView> {
    assertDoor(principal, door);
    const status = statusFilter(query.status);
    const gate = await this.frameGate(context, principal, frameId, VIEW_ACTION);
    const client = principal.kind === 'client';
    return this.database.read(context, async (runner) => {
      const rows = await this.threads.listForSubject(runner, context, {
        subjectType: 'figma_frame',
        subjectId: frameId,
        status,
        audiences: client ? ['client_visible'] : ['internal', 'client_visible'],
      });
      return { threads: await this.views(runner, context, principal, gate.canWrite, rows) };
    });
  }

  /**
   * `POST figma/frames/:frameId/review/threads` — a pin, box or drawing on a frame's snapshot.
   * A thread on an internal link stays internal: the client cannot open that link at all.
   */
  async createFrameThread(
    context: TenantContext,
    principal: Principal,
    door: ReviewDoor,
    frameId: string,
    input: CreateThreadInput,
  ): Promise<ReviewThreadView> {
    assertDoor(principal, door);
    const body = requiredBody(input.body);
    const anchorKind = anchorKindOf(input.anchorKind);
    if (anchorKind === 'time' || anchorKind === 'cell') {
      throw invalid('anchorKind', 'must be pin, box, draw or none on a Figma frame');
    }
    const place = parseAnchor(anchorKind, input.anchor, null);
    const requestedAudience = audienceOf(input.audience);
    const mentions = mentionedIds(body, input.mentions, principal.userId);

    const gate = await this.frameGate(context, principal, frameId, CREATE_ACTION);
    this.requireWrite(gate);
    const frame = gate.frame;
    const client = principal.kind === 'client';
    const named = await this.database.read(context, (runner) =>
      this.checkMentions(runner, context, principal, frame.projectId, mentions),
    );
    const namesClient = named.some((row) => row.kind === 'client');
    let audience: ReviewAudience;
    if (client) {
      if (requestedAudience === 'internal') throw invalid('audience', 'must be client_visible');
      audience = 'client_visible';
    } else if (requestedAudience === null) {
      audience = namesClient && frame.audience === 'client_visible' ? 'client_visible' : 'internal';
    } else {
      audience = requestedAudience;
    }
    if (audience === 'client_visible' && frame.audience !== 'client_visible') {
      throw invalid('audience', 'this Figma link is for the team only');
    }
    if (audience === 'internal' && namesClient) {
      throw invalid('mentions', 'a client cannot be mentioned on an internal comment');
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.database.transaction(context, async (tx) => {
          const number = await this.threads.lockNextNumber(tx, context, 'figma_frame', frameId);
          const thread = await this.threads.insert(tx, context, {
            projectId: frame.projectId,
            subjectType: 'figma_frame',
            subjectId: frameId,
            fileVersionId: null,
            anchorKind,
            anchor: place.anchor,
            pageNo: null,
            timeMs: null,
            number,
            audience,
            createdByMembershipId: context.membershipId,
          });
          const comment = await this.comments.insert(tx, context, {
            threadId: thread.id,
            body,
            mentions,
            createdByMembershipId: context.membershipId,
          });
          await this.audit.record(tx, context, {
            action: CREATE_ACTION,
            objectId: thread.id,
            result: 'allowed',
            actorUserId: principal.userId,
            metadata: {
              project_id: frame.projectId,
              figma_frame_id: frameId,
              audience,
              anchor_kind: anchorKind,
              mention_count: mentions.length,
              principal_kind: principal.kind,
            },
          });
          await this.outbox?.append(tx, context, {
            type: 'review.thread_created.v1',
            aggregateId: thread.id,
            payload: {
              threadId: thread.id,
              commentId: comment.id,
              subjectType: 'figma_frame',
              subjectId: frameId,
              fileAssetId: null,
              projectId: frame.projectId,
              audience,
              authorUserId: principal.userId,
              mentionedUserIds: mentions,
            },
          });
          return thread;
        });
        return await this.database.read(context, async (runner) => {
          const [view] = await this.views(runner, context, principal, true, [created]);
          if (!view) throw new Error('review thread vanished after create');
          return view;
        });
      } catch (error) {
        if (isRetryableNumberRace(error) && attempt < NUMBER_ATTEMPTS) {
          await new Promise((done) =>
            setTimeout(done, 5 + Math.floor(Math.random() * 20 * attempt)),
          );
          continue;
        }
        if (isRetryableNumberRace(error)) {
          throw new ApiError(409, 'conflict', 'Someone else just added a comment. Try again');
        }
        throw error;
      }
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /** The download door's decision for this file, plus whether the caller may write on it. */
  private async gate(
    context: TenantContext,
    principal: Principal,
    fileId: string,
    action: AuditAction,
  ): Promise<Gate> {
    const resolved = await this.downloads.resolve(context, principal, fileId, action);
    return {
      resolved,
      canWrite: this.mayWrite(principal, resolved),
      archived: resolved.project.archivedAt !== null,
      fileAssetId: resolved.asset.id,
    };
  }

  /** A thread by id, through its file's gate. A thread the caller may not see is the one 404. */
  private async threadGate(
    context: TenantContext,
    principal: Principal,
    threadId: string,
    action: AuditAction,
  ): Promise<{ thread: ReviewThread; gate: WriteGate }> {
    const frameThread = await this.database.read(context, async (runner) => {
      const thread = await this.threads.findById(runner, context, threadId);
      return thread && thread.deletedAt === null && thread.subjectType === 'figma_frame'
        ? thread
        : null;
    });
    if (frameThread) {
      const gate = await this.frameGate(context, principal, frameThread.subjectId, action);
      if (principal.kind === 'client' && frameThread.audience !== 'client_visible') {
        throw await this.downloads.refuse(context, 'review_thread_internal', action);
      }
      return { thread: frameThread, gate };
    }
    const found = await this.database.read(context, async (runner) => {
      const thread = await this.threads.findById(runner, context, threadId);
      if (!thread || thread.deletedAt !== null || thread.subjectType !== 'file_asset') return null;
      if (thread.fileVersionId === null) return null;
      const assetId = await this.threads.assetOfVersion(runner, context, thread.fileVersionId);
      return assetId === null ? null : { thread, assetId };
    });
    if (!found) throw await this.downloads.refuse(context, 'review_thread_not_found', action);
    const gate = await this.gate(context, principal, found.assetId, action);
    if (principal.kind === 'client' && found.thread.audience !== 'client_visible') {
      throw await this.downloads.refuse(context, 'review_thread_internal', action);
    }
    return { thread: found.thread, gate };
  }

  /** A Figma frame through the Figma module's read decision; anything else is the one 404. */
  private async frameGate(
    context: TenantContext,
    principal: Principal,
    frameId: string,
    action: AuditAction,
  ): Promise<WriteGate & { readonly frame: ReviewFrameSubject }> {
    const frame = this.frames ? await this.frames.resolveFrame(context, principal, frameId) : null;
    if (!frame) throw await this.downloads.refuse(context, 'figma_frame_not_found', action);
    const client = principal.kind === 'client';
    const canWrite =
      !frame.archived &&
      authorize({
        principal,
        capability: 'file.upload',
        resource: {
          organizationId: frame.organizationId,
          projectId: frame.projectId,
          audience: client ? 'client_visible' : frame.audience,
          clientOrganizationId: client ? principal.clientOrganizationId : null,
          lifecycle: 'active',
        },
      }).allowed;
    return { frame, canWrite, archived: frame.archived, fileAssetId: null };
  }

  private async liveComment(context: TenantContext, commentId: string): Promise<ReviewComment> {
    const comment = await this.database.read(context, (runner) =>
      this.comments.findById(runner, context, commentId),
    );
    if (!comment || comment.deletedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return comment;
  }

  private requireWrite(gate: WriteGate): void {
    if (!gate.canWrite) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        gate.archived ? 'project_archived' : 'review_write_denied',
      );
    }
  }

  private mayWrite(principal: Principal, resolved: ResolvedFile): boolean {
    if (resolved.project.archivedAt !== null) return false;
    const { asset } = resolved;
    return authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        // The gate already decided the caller may read this file; for a client it is client
        // content (a published deliverable's file may have been uploaded internal).
        audience: principal.kind === 'client' ? 'client_visible' : asset.audience,
        clientOrganizationId: asset.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }

  private mayResolve(context: TenantContext, principal: Principal, thread: ReviewThread): boolean {
    return principal.kind === 'internal' || thread.createdByMembershipId === context.membershipId;
  }

  private withinEditWindow(comment: ReviewComment): boolean {
    return this.now().getTime() - comment.createdAt.getTime() <= EDIT_WINDOW_MS;
  }

  /** The thread subject: the root of the file's version chain, or the file itself. */
  private async subjectOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    asset: FileAssetRow,
  ): Promise<string> {
    const link = await this.versions.findInvolving(runner, context, asset.id);
    return link ? link.rootFileAssetId : asset.id;
  }

  /**
   * Every mentioned id must be somebody the caller may name on this project: staff on the project
   * and the project's client contacts (a client: only its own organization's). One unknown id
   * refuses the comment.
   */
  private async checkMentions(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    projectId: string,
    mentions: readonly string[],
  ): Promise<readonly MentionCandidateRow[]> {
    if (mentions.length === 0) return [];
    const client = principal.kind === 'client';
    const rows = await this.people.search(runner, context, {
      projectId,
      prefix: '',
      userIds: mentions,
      includeStaff: true,
      includeClients: true,
      clientOrganizationId: client ? principal.clientOrganizationId : null,
      limit: MAX_MENTIONS * 2,
    });
    const known = new Set(rows.map((row) => row.userId.toLowerCase()));
    if (mentions.some((id) => !known.has(id))) {
      throw invalid('mentions', 'names somebody who is not on this project');
    }
    return rows;
  }

  private async freshView(
    context: TenantContext,
    principal: Principal,
    threadId: string,
    canWrite: boolean,
  ): Promise<ReviewThreadView> {
    return this.database.read(context, async (runner) => {
      const thread = await this.threads.findById(runner, context, threadId);
      if (!thread || thread.deletedAt !== null) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      const [view] = await this.views(runner, context, principal, canWrite, [thread]);
      if (!view) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return view;
    });
  }

  private async views(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    canWrite: boolean,
    threads: readonly ReviewThread[],
  ): Promise<ReviewThreadView[]> {
    const comments = await this.comments.listForThreads(
      runner,
      context,
      threads.map((thread) => thread.id),
    );
    const membershipIds = [
      ...threads.map((thread) => thread.createdByMembershipId),
      ...threads.flatMap((thread) =>
        thread.resolvedByMembershipId ? [thread.resolvedByMembershipId] : [],
      ),
      ...comments.map((comment) => comment.createdByMembershipId),
    ];
    const people = await this.peopleMap(runner, context, membershipIds);
    const byThread = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const list = byThread.get(comment.threadId) ?? [];
      list.push(comment);
      byThread.set(comment.threadId, list);
    }
    const out: ReviewThreadView[] = [];
    for (const thread of threads) {
      const own = thread.createdByMembershipId === context.membershipId;
      const list = byThread.get(thread.id) ?? [];
      // A thread whose every comment was removed is gone too (the delete removes it).
      if (list.length === 0) continue;
      out.push({
        id: thread.id,
        number: thread.number,
        subjectType: thread.subjectType,
        subjectId: thread.subjectId,
        fileVersionId: thread.fileVersionId,
        anchorKind: thread.anchorKind,
        anchor: thread.anchor,
        pageNo: thread.pageNo,
        timeMs: thread.timeMs,
        audience: thread.audience,
        status: thread.status,
        createdBy: personView(people, thread.createdByMembershipId),
        createdAt: thread.createdAt.toISOString(),
        resolvedBy: thread.resolvedByMembershipId
          ? personView(people, thread.resolvedByMembershipId)
          : null,
        resolvedAt: thread.resolvedAt ? thread.resolvedAt.toISOString() : null,
        carriedFromThreadId: thread.carriedFromThreadId,
        comments: list.map((comment) => this.commentView(context, comment, people, canWrite)),
        canResolve: canWrite && this.mayResolve(context, principal, thread),
        canMove: canWrite && own && thread.anchorKind !== 'none',
      });
    }
    return out;
  }

  private commentView(
    context: TenantContext,
    comment: ReviewComment,
    people: ReadonlyMap<string, ReviewPersonRow>,
    canWrite: boolean,
  ): ReviewCommentView {
    const own = comment.createdByMembershipId === context.membershipId;
    return {
      id: comment.id,
      threadId: comment.threadId,
      body: comment.body,
      mentions: comment.mentions,
      author: personView(people, comment.createdByMembershipId),
      createdAt: comment.createdAt.toISOString(),
      editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
      canEdit: canWrite && own && this.withinEditWindow(comment),
      canDelete: canWrite && own,
    };
  }

  private async peopleMap(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReviewPersonRow>> {
    const rows = await this.people.peopleByMembership(runner, context, membershipIds);
    return new Map(rows.map((row) => [row.membershipId, row]));
  }
}

function personView(
  people: ReadonlyMap<string, ReviewPersonRow>,
  membershipId: string,
): ReviewPersonView {
  const found = people.get(membershipId);
  return {
    membershipId,
    displayName: found ? found.displayName : null,
    kind: found ? found.kind : 'internal',
  };
}

function audienceOf(raw: unknown): ReviewAudience | null {
  if (raw === undefined || raw === null) return null;
  if (raw === 'internal' || raw === 'client_visible') return raw;
  throw invalid('audience', 'must be internal or client_visible');
}

function statusFilter(raw: string | undefined): ReviewThreadStatus | undefined {
  if (raw === undefined || raw === '' || raw === 'all') return undefined;
  if (raw === 'open' || raw === 'resolved') return raw;
  throw badRequest('status', 'must be open, resolved or all');
}
