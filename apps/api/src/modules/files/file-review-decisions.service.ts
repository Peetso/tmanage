import { authorize } from '@tmanage/domain';
import type { AuditAction, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { FileAssetRow, FileReviewDecisionRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import { FileAssetsRepository } from './file-assets.repository.js';
import { FileClientRelation } from './file-client-relation.js';
import { assertDoor } from './file-download.service.js';
import type { FileDownloadService, ResolvedFile } from './file-download.service.js';
import {
  FILE_REVIEW_DECISIONS,
  FileReviewDecisionsRepository,
  type FileReviewDecision,
} from './file-review-decisions.repository.js';
import { ReviewMentionCandidatesRepository } from './review-mention-candidates.repository.js';
import type { ReviewPersonRow } from './review-mention-candidates.repository.js';
import { ReviewThreadsRepository } from './review-threads.repository.js';
import type { ReviewAudience } from './review-threads.repository.js';

/**
 * R4 slice 11 — Approve / Request changes on the versions of a **plain** attachment (V-33, V-34),
 * and the per-version review state the Versions tab shows (V-30).
 *
 * The rules, in the order they run:
 *
 * - The file is resolved through the download door (the same gate, the same one 404) for the
 *   door the caller came through; a client reaches only what the client relation lets it reach.
 * - The decided version must be in the same version chain as the file in the path.
 * - A version that is a deliverable's file answers 409 `use_deliverable_approval` and names the
 *   deliverable version: its decision goes through the existing approval routes.
 * - Deciding needs `approval.decide` on the file's project (a client role's ceiling holds it; a
 *   Client Viewer does not) and an active project.
 * - Asking for changes needs a note (the table's trigger says so too).
 *
 * Decisions are append-only; a version's state is its newest decision, else "in review" when it
 * has an open comment or a client-visible one, else "shared". A client sees only client decisions
 * and client-visible comments.
 */

export const FILE_REVIEW_DECISIONS_SERVICE = Symbol.for('tmanage.FileReviewDecisionsService');

const DECIDE_ACTION: AuditAction = 'review.decision_recorded';
const VIEW_ACTION: AuditAction = 'file_preview.viewed';
const MAX_NOTE = 2_000;

export type FileReviewDoor = 'internal' | 'client';
export type FileVersionReviewState = 'approved' | 'changes_requested' | 'in_review' | 'shared';

export interface FileReviewPersonView {
  readonly membershipId: string;
  /** `null` when the person is no longer a member. */
  readonly displayName: string | null;
  readonly kind: 'internal' | 'client';
}

export interface FileReviewDecisionView {
  readonly id: string;
  readonly fileAssetId: string;
  readonly versionNo: number;
  readonly decision: FileReviewDecision;
  readonly note: string | null;
  readonly decidedBy: FileReviewPersonView;
  readonly createdAt: string;
}

export interface FileVersionReviewView {
  readonly fileAssetId: string;
  readonly versionNo: number;
  readonly state: FileVersionReviewState;
  readonly openThreads: number;
  readonly resolvedThreads: number;
  /** Comments that travelled here from the version before. */
  readonly carriedThreads: number;
  readonly latestDecision: FileReviewDecisionView | null;
}

export interface FileReviewDecisionsView {
  readonly rootFileAssetId: string;
  /** Newest first: every version of the chain the caller may open. */
  readonly versions: readonly FileVersionReviewView[];
  /** Every decision the caller may see, newest first. */
  readonly history: readonly FileReviewDecisionView[];
}

export interface RecordDecisionInput {
  /** The version decided; the file in the path when omitted. */
  readonly fileAssetId?: unknown;
  readonly decision?: unknown;
  readonly note?: unknown;
}

interface ChainMember {
  readonly versionNo: number;
  readonly asset: FileAssetRow;
}

export class FileReviewDecisionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly downloads: FileDownloadService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxEventsRepository | null,
    private readonly decisions: FileReviewDecisionsRepository = new FileReviewDecisionsRepository(),
    private readonly assets: FileAssetsRepository = new FileAssetsRepository(),
    private readonly versions: AttachmentVersionsRepository = new AttachmentVersionsRepository(),
    private readonly threads: ReviewThreadsRepository = new ReviewThreadsRepository(),
    private readonly people: ReviewMentionCandidatesRepository = new ReviewMentionCandidatesRepository(),
    private readonly relation: FileClientRelation = new FileClientRelation(),
  ) {}

  /** `GET files/:fileId/review/decisions` (studio) and `portal/files/:fileId/review/decisions`. */
  async list(
    context: TenantContext,
    principal: Principal,
    door: FileReviewDoor,
    fileId: string,
  ): Promise<FileReviewDecisionsView> {
    assertDoor(principal, door);
    const resolved = await this.downloads.resolve(context, principal, fileId, VIEW_ACTION);
    return this.database.read(context, (runner) =>
      this.view(runner, context, principal, resolved.asset),
    );
  }

  /** `POST files/:fileId/review/decisions` — `{fileAssetId?, decision, note?}`. */
  async record(
    context: TenantContext,
    principal: Principal,
    door: FileReviewDoor,
    fileId: string,
    input: RecordDecisionInput,
  ): Promise<FileReviewDecisionsView> {
    assertDoor(principal, door);
    const decision = decisionOf(input.decision);
    const note = noteOf(input.note);
    if (decision === 'changes_requested' && note === null) {
      throw invalid('note', 'say what should change');
    }
    const targetId = input.fileAssetId === undefined ? fileId : input.fileAssetId;
    if (typeof targetId !== 'string' || targetId === '' || targetId.length > 36) {
      throw invalid('fileAssetId', 'must be a file id');
    }

    const named = await this.downloads.resolve(context, principal, fileId, DECIDE_ACTION);
    const target =
      targetId === named.asset.id
        ? named
        : await this.downloads.resolve(context, principal, targetId, DECIDE_ACTION);

    const { rootId, deliverable } = await this.database.read(context, async (runner) => ({
      rootId: {
        named: await this.rootOf(runner, context, named.asset),
        target: await this.rootOf(runner, context, target.asset),
      },
      deliverable: await this.decisions.deliverableVersionFor(runner, context, target.asset.id),
    }));
    if (rootId.named !== rootId.target) {
      throw invalid('fileAssetId', 'must be a version of this file');
    }
    if (deliverable) {
      throw new ApiError(
        409,
        'conflict',
        'This file is a deliverable. Decide through its approval',
        [
          { field: 'deliverableId', message: deliverable.deliverableId },
          { field: 'deliverableVersionId', message: deliverable.id },
        ],
        'use_deliverable_approval',
      );
    }
    if (target.project.archivedAt !== null) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'project_archived');
    }
    if (!this.mayDecide(principal, target)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'decision_denied');
    }

    return this.database.transaction(context, async (tx) => {
      const row = await this.decisions.insert(tx, context, {
        projectId: target.asset.projectId,
        rootFileAssetId: rootId.target,
        fileAssetId: target.asset.id,
        fileVersionId: target.version?.id ?? null,
        decision,
        note,
        decidedByMembershipId: context.membershipId,
        decidedByUserId: principal.userId,
        principalKind: principal.kind === 'client' ? 'client' : 'internal',
        clientOrganizationId: principal.kind === 'client' ? principal.clientOrganizationId : null,
      });
      await this.audit.record(tx, context, {
        action: DECIDE_ACTION,
        objectId: target.asset.id,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          project_id: target.asset.projectId,
          root_file_asset_id: rootId.target,
          decision_id: row.id,
          decision,
          principal_kind: principal.kind,
        },
      });
      await this.outbox?.append(tx, context, {
        type: 'review.decision_recorded.v1',
        aggregateId: target.asset.id,
        payload: {
          decisionId: row.id,
          rootFileAssetId: rootId.target,
          fileAssetId: target.asset.id,
          projectId: target.asset.projectId,
          decision,
          byUserId: principal.userId,
          principalKind: principal.kind === 'client' ? 'client' : 'internal',
        },
      });
      return this.view(tx, context, principal, target.asset);
    });
  }

  private mayDecide(principal: Principal, resolved: ResolvedFile): boolean {
    const { asset } = resolved;
    return authorize({
      principal,
      capability: 'approval.decide',
      resource: {
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        // The gate already decided the caller may read this file.
        audience: principal.kind === 'client' ? 'client_visible' : asset.audience,
        clientOrganizationId: asset.clientOrganizationId,
        lifecycle: 'active',
        // A plain file's decision is open to any client whose role holds `approval.decide`
        // (SPEC §3.4), as the manifest's `canDecide` says.
        isAssignedReviewer: true,
      },
    }).allowed;
  }

  private async rootOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    asset: FileAssetRow,
  ): Promise<string> {
    const link = await this.versions.findInvolving(runner, context, asset.id);
    return link ? link.rootFileAssetId : asset.id;
  }

  /** The chain's versions the caller may open, newest first. */
  private async chain(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
    rootId: string,
  ): Promise<readonly ChainMember[]> {
    const root = rootId === asset.id ? asset : await this.assets.findById(runner, context, rootId);
    const members: ChainMember[] = root ? [{ versionNo: 1, asset: root }] : [];
    for (const row of await this.versions.listForRoot(runner, context, rootId)) {
      const member =
        row.fileAssetId === asset.id
          ? asset
          : await this.assets.findById(runner, context, row.fileAssetId);
      if (member) members.push({ versionNo: row.versionNo, asset: member });
    }
    const visible: ChainMember[] = [];
    for (const member of members) {
      if (
        member.asset.id === asset.id ||
        (await this.mayOpen(runner, context, principal, member.asset))
      ) {
        visible.push(member);
      }
    }
    return visible.sort((a, b) => b.versionNo - a.versionNo);
  }

  /** The download door's read decision for another version (no scan state, no audit row). */
  private async mayOpen(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    member: FileAssetRow,
  ): Promise<boolean> {
    if (member.deletedAt !== null) return false;
    let audience = member.audience;
    if (principal.kind === 'client') {
      const reach = await this.relation.reach(runner, context, principal, member);
      if (!reach) return false;
      audience = reach.audience;
    }
    return authorize({
      principal,
      capability: 'file.download',
      resource: {
        organizationId: member.organizationId,
        projectId: member.projectId,
        audience,
        clientOrganizationId: member.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }

  private async view(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
  ): Promise<FileReviewDecisionsView> {
    const client = principal.kind === 'client';
    const rootId = await this.rootOf(runner, context, asset);
    const members = await this.chain(runner, context, principal, asset, rootId);
    const visibleIds = new Set(members.map((member) => member.asset.id));
    const versionNoOf = new Map(members.map((member) => [member.asset.id, member.versionNo]));

    const rows = (await this.decisions.listForRoot(runner, context, rootId)).filter(
      (row) => visibleIds.has(row.fileAssetId) && (!client || row.principalKind === 'client'),
    );
    const people = await this.peopleMap(
      runner,
      context,
      rows.map((row) => row.decidedByMembershipId),
    );
    const history = rows.map((row) =>
      decisionView(row, versionNoOf.get(row.fileAssetId) ?? 1, people),
    );

    const audiences: readonly ReviewAudience[] = client
      ? ['client_visible']
      : ['internal', 'client_visible'];
    const counts = new Map(
      (await this.threads.countsByVersion(runner, context, rootId, audiences)).map((entry) => [
        entry.fileVersionId,
        entry,
      ]),
    );
    const shown = new Set(
      (await this.threads.countsByVersion(runner, context, rootId, ['client_visible'])).map(
        (entry) => entry.fileVersionId,
      ),
    );

    const versions: FileVersionReviewView[] = [];
    for (const member of members) {
      const latest = await this.assets.findLatestVersion(runner, context, member.asset.id);
      const count = latest ? counts.get(latest.id) : undefined;
      const latestDecision = history.find((entry) => entry.fileAssetId === member.asset.id) ?? null;
      const openThreads = count?.open ?? 0;
      versions.push({
        fileAssetId: member.asset.id,
        versionNo: member.versionNo,
        state: stateOf(latestDecision, openThreads, latest ? shown.has(latest.id) : false),
        openThreads,
        resolvedThreads: count?.resolved ?? 0,
        carriedThreads: count?.carried ?? 0,
        latestDecision,
      });
    }
    return { rootFileAssetId: rootId, versions, history };
  }

  private async peopleMap(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReviewPersonRow>> {
    const unique = [...new Set(membershipIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.people.peopleByMembership(runner, context, unique);
    return new Map(rows.map((row) => [row.membershipId, row]));
  }
}

/** A version's state: its newest decision, else in review (open or client-visible comments), else shared. */
export function stateOf(
  latest: FileReviewDecisionView | null,
  openThreads: number,
  hasClientVisibleThread: boolean,
): FileVersionReviewState {
  if (latest) return latest.decision;
  return openThreads > 0 || hasClientVisibleThread ? 'in_review' : 'shared';
}

function decisionView(
  row: FileReviewDecisionRow,
  versionNo: number,
  people: ReadonlyMap<string, ReviewPersonRow>,
): FileReviewDecisionView {
  const person = people.get(row.decidedByMembershipId);
  return {
    id: row.id,
    fileAssetId: row.fileAssetId,
    versionNo,
    decision: row.decision as FileReviewDecision,
    note: row.note,
    decidedBy: {
      membershipId: row.decidedByMembershipId,
      displayName: person ? person.displayName : null,
      kind: person ? person.kind : row.principalKind === 'client' ? 'client' : 'internal',
    },
    createdAt: row.createdAt.toISOString(),
  };
}

function decisionOf(raw: unknown): FileReviewDecision {
  if (typeof raw === 'string' && (FILE_REVIEW_DECISIONS as readonly string[]).includes(raw)) {
    return raw as FileReviewDecision;
  }
  throw invalid('decision', 'must be approved or changes_requested');
}

function noteOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalid('note', 'must be a string or null');
  const trimmed = raw.trim();
  if (trimmed.length > MAX_NOTE) throw invalid('note', `must be at most ${MAX_NOTE} characters`);
  return trimmed === '' ? null : trimmed;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}
