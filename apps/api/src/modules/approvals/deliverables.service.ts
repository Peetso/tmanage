import { createHash } from 'node:crypto';
import { authorize, hasCapability, isClientRole } from '@tmanage/domain';
import type { ApprovalState, Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  ApprovalRow,
  DeliverableRow,
  DeliverableVersionRow,
} from '../../common/database/schema.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { assertVersionOpenable } from './approval-open-preconditions.js';
import { ApprovalVersionConflictError } from './approvals.repository.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import { ClientProjectionAlreadyExistsError } from './client-projections.repository.js';
import type { ClientProjectionsRepository } from './client-projections.repository.js';
import { DeliverableNotFoundError } from './deliverables.repository.js';
import type { DeliverablesRepository } from './deliverables.repository.js';

/**
 * 0211 (audit gap 1, APR-01/02) — the studio half of client approval.
 *
 * A team member creates a deliverable on a project, uploads versions to it (an attached file and a
 * note), and sends one version to chosen client approvers. Sending is one transaction: it freezes
 * the client-safe projection the portal's Approve screen reads (x97), opens the approval the
 * existing client decide route consumes (x92) with the approvers as its reviewer list, and appends
 * `approval.requested.v1` so the worker emails them. Requesting changes is the existing client
 * route; the loop closes when the team uploads the next version, which invalidates any approval
 * still pending on an older one (FR-05: "changed governed content … invalidates pending approval")
 * and can then be sent again.
 *
 * Every object-layer refusal is 404, for the reason `ApprovalsService` gives. Clients never reach
 * this service: every capability it checks is internal-only.
 */

export type DeliverableState = 'draft' | 'in_review' | 'changes_requested' | 'approved';

export interface DeliverableVersionView {
  readonly id: string;
  readonly versionNo: number | null;
  readonly fileAssetId: string | null;
  readonly fileVersionId: string | null;
  readonly note: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  /** The newest approval on this version, if it was ever sent. */
  readonly approval: {
    readonly id: string;
    readonly state: ApprovalState;
    readonly reviewerIds: readonly string[];
    readonly feedback: string | null;
    readonly decidedAt: string | null;
  } | null;
}

export interface DeliverableView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: DeliverableState;
  readonly latestVersionNo: number | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliverableDetailView extends DeliverableView {
  readonly versions: readonly DeliverableVersionView[];
}

export interface ApproverView {
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationName: string;
}

export interface SendForApprovalInput {
  readonly approverIds: readonly string[];
  /** "Decision needed by" — an ISO date, shown to the client as the projection's forecast date. */
  readonly dueDate: string | null;
  /** "What should they check?" — client-visible, the projection's summary. */
  readonly checkNote: string | null;
  /** "Email the approver now". */
  readonly notify: boolean;
}

export interface SendForApprovalView {
  readonly approvalId: string;
  readonly deliverableVersionId: string;
  readonly state: ApprovalState;
  readonly reviewerIds: readonly string[];
}

const PENDING: ReadonlySet<string> = new Set(['draft', 'requested', 'viewed']);

/** The deliverable's state, read off its newest version's newest approval. */
export function deliverableState(
  latest: DeliverableVersionRow | undefined,
  approvalsNewestFirst: readonly ApprovalRow[],
): DeliverableState {
  if (!latest) return 'draft';
  const approval = approvalsNewestFirst.find((a) => a.deliverableVersionId === latest.id);
  if (!approval) return 'draft';
  if (approval.state === 'approved') return 'approved';
  if (approval.state === 'changes_requested') return 'changes_requested';
  if (PENDING.has(approval.state)) return 'in_review';
  return 'draft';
}

/** The governed hash of a version: the exact file bytes' hash plus everything that names it. */
export function versionContentHash(parts: {
  readonly deliverableId: string;
  readonly versionNo: number;
  readonly fileVersionId: string | null;
  readonly fileHash: string | null;
  readonly note: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function toView(
  row: DeliverableRow,
  versions: readonly DeliverableVersionRow[],
  all: readonly ApprovalRow[],
): DeliverableView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    state: deliverableState(versions[0], all),
    latestVersionNo: versions[0]?.versionNo ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersionView(
  row: DeliverableVersionRow,
  all: readonly ApprovalRow[],
): DeliverableVersionView {
  const approval = all.find((a) => a.deliverableVersionId === row.id);
  return {
    id: row.id,
    versionNo: row.versionNo,
    fileAssetId: row.fileAssetId,
    fileVersionId: row.fileVersionId,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    approval: approval
      ? {
          id: approval.id,
          state: approval.state as ApprovalState,
          reviewerIds: approval.reviewerIds,
          feedback: approval.feedback,
          decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
        }
      : null,
  };
}

export class DeliverablesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly deliverables: DeliverablesRepository,
    private readonly versions: DeliverableVersionsRepository,
    private readonly approvals: ApprovalsRepository,
    private readonly projections: ClientProjectionsRepository,
    private readonly projects: ProjectsRepository,
    private readonly outbox?: OutboxEventsRepository,
    /** Q3: deliverable actions leave an audit row in their own transaction (ids only). */
    private readonly audit?: AuditService,
  ) {}

  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly title: string;
      readonly description: string | null;
    },
  ): Promise<DeliverableView> {
    return this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const project = await this.projects.findById(tx, context, input.projectId);
        if (!project || project.archivedAt !== null) throw notFound('project_not_found');
        this.require(principal, 'deliverable.create', context, project.id);
        const row = await this.deliverables.create(tx, context, {
          ...input,
          createdByUserId: principal.userId,
        });
        await this.audit?.record(tx, context, {
          action: 'deliverable.created',
          objectId: row.id,
          result: 'allowed',
          metadata: { project_id: project.id },
        });
        return toView(row, [], []);
      }),
    );
  }

  async list(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly DeliverableView[]> {
    this.require(principal, 'work.read', context, projectId);
    return this.database.read(context, async (runner) => {
      const rows = await this.deliverables.listByProject(runner, context, projectId);
      const out: DeliverableView[] = [];
      for (const row of rows) {
        const versions = await this.versions.listForDeliverable(runner, context, row.id);
        const all = await this.deliverables.approvalsFor(runner, context, row.id);
        out.push(toView(row, versions, all));
      }
      return out;
    });
  }

  async detail(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
  ): Promise<DeliverableDetailView> {
    return this.guarding(() =>
      this.database.read(context, async (runner) => {
        const row = await this.deliverables.requireById(runner, context, deliverableId);
        this.require(principal, 'work.read', context, row.projectId);
        const versions = await this.versions.listForDeliverable(runner, context, row.id);
        const all = await this.deliverables.approvalsFor(runner, context, row.id);
        return {
          ...toView(row, versions, all),
          versions: versions.map((v) => toVersionView(v, all)),
        };
      }),
    );
  }

  /**
   * Upload a new version. The file must be a `deliverable` upload in the same project (attached to
   * this deliverable or not yet attached to anything). Any approval still pending on an older
   * version is invalidated in the same transaction — "uploading a new version asks again".
   */
  async addVersion(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
    input: { readonly fileAssetId: string | null; readonly note: string | null },
  ): Promise<DeliverableVersionView> {
    if (input.fileAssetId === null && (input.note ?? '').trim() === '') {
      throw new ApiError(400, 'validation_failed', 'A version needs a file or a note', [
        { field: 'fileAssetId', message: 'attach a file or write a note' },
      ]);
    }
    return this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const deliverable = await this.deliverables.requireById(tx, context, deliverableId);
        this.require(principal, 'deliverable.create', context, deliverable.projectId);

        let fileVersionId: string | null = null;
        let fileHash: string | null = null;
        if (input.fileAssetId !== null) {
          const file = await this.deliverables.fileWithLatestVersion(
            tx,
            context,
            input.fileAssetId,
          );
          const usable =
            file !== null &&
            file.version !== null &&
            file.asset.projectId === deliverable.projectId &&
            file.asset.purpose === 'deliverable' &&
            (file.asset.objectId === null || file.asset.objectId === deliverable.id) &&
            file.asset.status === 'ready';
          if (!usable || !file?.version) {
            throw new ApiError(422, 'validation_failed', 'That file cannot be attached', [
              { field: 'fileAssetId', message: 'must be a ready deliverable file in this project' },
            ]);
          }
          fileVersionId = file.version.id;
          fileHash = file.version.contentHash;
        }

        const previous = await this.versions.listForDeliverable(tx, context, deliverable.id);
        const versionNo = Math.max(0, ...previous.map((v) => v.versionNo ?? 0)) + 1;
        await this.invalidatePending(tx, context, deliverable.id);

        const created = await this.versions.create(tx, context, {
          projectId: deliverable.projectId,
          deliverableId: deliverable.id,
          versionNo,
          fileAssetId: input.fileAssetId,
          fileVersionId,
          note: input.note,
          contentHash: versionContentHash({
            deliverableId: deliverable.id,
            versionNo,
            fileVersionId,
            fileHash,
            note: input.note,
          }),
          createdByUserId: principal.userId,
        });
        await this.deliverables.touch(tx, context, deliverable.id);
        await this.audit?.record(tx, context, {
          action: 'deliverable.version_added',
          objectId: deliverable.id,
          result: 'allowed',
          metadata: {
            project_id: deliverable.projectId,
            deliverable_version_id: created.id,
            version_no: versionNo,
            file_asset_id: input.fileAssetId,
          },
        });
        return toVersionView(created, []);
      }),
    );
  }

  /** The client people who may approve — the "Approver" picker ("people with approval authority"). */
  async approvers(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
  ): Promise<readonly ApproverView[]> {
    return this.guarding(() =>
      this.database.read(context, async (runner) => {
        const deliverable = await this.deliverables.requireById(runner, context, deliverableId);
        this.require(principal, 'deliverable.publish', context, deliverable.projectId);
        return this.deciders(runner, context, deliverable.projectId);
      }),
    );
  }

  /**
   * Send one version for client approval: projection + approval + outbox event, atomically. Only
   * the deliverable's newest version may be sent, and not while it already has a live approval.
   */
  async send(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
    versionId: string,
    input: SendForApprovalInput,
  ): Promise<SendForApprovalView> {
    if (input.approverIds.length === 0) {
      throw new ApiError(400, 'validation_failed', 'Pick at least one approver', [
        { field: 'approverIds', message: 'must not be empty' },
      ]);
    }
    return this.guarding(() =>
      this.database.transaction(context, async (tx) => {
        const deliverable = await this.deliverables.requireById(tx, context, deliverableId);
        this.require(principal, 'deliverable.publish', context, deliverable.projectId);
        this.require(principal, 'deliverable.review', context, deliverable.projectId);

        const latest = await this.versions.latestForDeliverable(tx, context, deliverable.id);
        if (!latest || latest.id !== versionId) {
          if (
            latest &&
            (await this.versions.findById(tx, context, versionId))?.deliverableId === deliverable.id
          ) {
            throw new ApiError(
              409,
              'conflict',
              'Only the newest version can be sent',
              undefined,
              'version_superseded',
            );
          }
          throw notFound('deliverable_version_not_found');
        }

        const allowed = new Set(
          (await this.deciders(tx, context, deliverable.projectId)).map((p) => p.userId),
        );
        const approverIds = [...new Set(input.approverIds)];
        const outsider = approverIds.find((id) => !allowed.has(id));
        if (outsider !== undefined) {
          throw new ApiError(422, 'validation_failed', 'An approver cannot approve this project', [
            { field: 'approverIds', message: 'must be client people with approval authority' },
          ]);
        }

        // F16/F17: the one precondition check `ApprovalsService.open` runs too — nothing pending or
        // decided on this version (a decided version is final), and the sender is not an approver.
        await assertVersionOpenable(
          tx,
          context,
          { approvals: this.approvals, versions: this.versions },
          {
            deliverableId: deliverable.id,
            deliverableVersionId: latest.id,
            requesterUserId: principal.userId,
            reviewerIds: approverIds,
          },
        );

        // The projection is append-only per version (0031): publish it the first time only.
        if (!(await this.projections.findByVersion(tx, context, latest.id))) {
          await this.projections.publish(tx, context, {
            projectId: deliverable.projectId,
            deliverableId: deliverable.id,
            deliverableVersionId: latest.id,
            contentHash: latest.contentHash,
            projection: {
              title: latest.versionNo
                ? `${deliverable.title} · v${latest.versionNo}`
                : deliverable.title,
              summary: input.checkNote,
              milestoneState: null,
              forecastDate: input.dueDate,
              publishedRisk: null,
              decision: null,
              approvedContacts: [],
            },
            publishedByUserId: principal.userId,
          });
        }

        const approval = await this.approvals.open(tx, context, {
          projectId: deliverable.projectId,
          deliverableId: deliverable.id,
          deliverableVersionId: latest.id,
          contentHash: latest.contentHash,
          reviewerIds: approverIds,
        });

        if (input.notify) {
          await this.outbox?.append(tx, context, {
            type: 'approval.requested.v1',
            aggregateId: approval.id,
            payload: {
              approvalId: approval.id,
              deliverableId: deliverable.id,
              deliverableVersionId: latest.id,
              projectId: deliverable.projectId,
              reviewerUserIds: approverIds,
            },
          });
        }
        await this.deliverables.touch(tx, context, deliverable.id);
        await this.audit?.record(tx, context, {
          action: 'deliverable.sent_for_approval',
          objectId: deliverable.id,
          result: 'allowed',
          metadata: {
            project_id: deliverable.projectId,
            deliverable_version_id: latest.id,
            approval_id: approval.id,
            reviewer_count: approverIds.length,
            due_date: input.dueDate,
          },
        });

        return {
          approvalId: approval.id,
          deliverableVersionId: latest.id,
          state: approval.state as ApprovalState,
          reviewerIds: approval.reviewerIds,
        };
      }),
    );
  }

  private async deciders(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ApproverView[]> {
    const people = await this.deliverables.clientPeopleFor(runner, context, projectId);
    const seen = new Set<string>();
    const out: ApproverView[] = [];
    for (const p of people) {
      // A client membership never holds a custom role (the resolver refuses one), so only a
      // built-in client role may decide; an internal role name on a client row is refused too.
      if (seen.has(p.userId) || !isClientRole(p.role) || !hasCapability(p.role, 'approval.decide'))
        continue;
      seen.add(p.userId);
      out.push({
        userId: p.userId,
        displayName: p.displayName,
        clientOrganizationName: p.clientOrganizationName,
      });
    }
    return out;
  }

  private async invalidatePending(
    tx: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ) {
    for (const approval of await this.deliverables.approvalsFor(tx, context, deliverableId)) {
      if (approval.state !== 'requested' && approval.state !== 'viewed') continue;
      await this.approvals.transition(tx, context, approval.id, approval.version, 'invalidated', {
        invalidationReason: 'a new version was uploaded',
      });
      await this.audit?.record(tx, context, {
        action: 'approval.invalidated',
        objectId: approval.id,
        result: 'allowed',
        metadata: {
          deliverable_id: deliverableId,
          deliverable_version_id: approval.deliverableVersionId,
          project_id: approval.projectId,
        },
      });
    }
  }

  private require(
    principal: Principal,
    capability: Capability,
    context: TenantContext,
    projectId: string,
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'client_visible',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }
  }

  private async guarding<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DeliverableNotFoundError) throw notFound('deliverable_not_found');
      if (
        error instanceof ApprovalVersionConflictError ||
        error instanceof ClientProjectionAlreadyExistsError
      ) {
        // A concurrent send or upload got there first.
        throw new ApiError(409, 'conflict', MESSAGES.conflict, undefined, 'version_conflict');
      }
      throw error;
    }
  }
}

function notFound(auditCode: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
}
