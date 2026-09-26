import { and, desc, eq, sql } from 'drizzle-orm';
import { approvalStateMachine, uuidv7 } from '@tmanage/domain';
import type { ApprovalPolicy, ApprovalState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvals } from '../../common/database/schema.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Approvals — FR-05's storage half, and the append-only lifecycle it holds.
 *
 * `ClientRequestsRepository`'s shape throughout: the tenant comes from the context and never the
 * input, a scoped read distinguishes wrong-tenant from stale-token so a caller in the wrong
 * tenant gets not-found rather than a conflict, and the facts a transition requires are written
 * in the same statement as the state. What differs is what the aggregate is: every transition
 * runs through `approvalStateMachine`, so an already-terminal approval has no outbound move and
 * is refused here as well as at the `0027` trigger — INT-16's "append-only".
 */

export class ApprovalNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval ${approvalId} was not found`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalVersionConflictError extends Error {
  constructor(
    readonly approvalId: string,
    readonly expectedVersion: number,
  ) {
    super(`Approval ${approvalId} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'ApprovalVersionConflictError';
  }
}

export class ApprovalTransitionError extends Error {
  constructor(
    readonly from: ApprovalState,
    readonly to: ApprovalState,
    readonly reason: 'illegal_transition' | 'missing_requirement',
    readonly missing: readonly string[],
    detail: string,
  ) {
    // From the state machine: names states and required field names, never row content.
    super(detail);
    this.name = 'ApprovalTransitionError';
  }
}

/**
 * What opening a request supplies. Note the absences: `organizationId` (context), and `state`,
 * which is the lifecycle's own and not a caller's to choose.
 */
export interface OpenApprovalInput {
  readonly projectId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  /** The hash captured at request time — compared, never re-derived, at decision time. */
  readonly contentHash: string;
  readonly reviewerIds: readonly string[];
  readonly policy?: ApprovalPolicy;
}

/** The facts a decision writes — keys match the `requires` lists in `approvalStateMachine`. */
export interface ApprovalDecisionFacts {
  readonly decidedByUserId?: string;
  readonly decidedAt?: Date;
  readonly contentHash?: string;
  readonly feedback?: string;
  readonly invalidationReason?: string;
}

export class ApprovalsRepository {
  /**
   * Open a request — the `draft -> requested` transition, persisted directly at `requested`.
   *
   * `draft` is transient: it is the machine's initial state, but the first thing worth storing is
   * the request itself, exactly as `ClientRequestsRepository.submit` persists at its lifecycle's
   * initial state. The transition is validated before the insert so the same requirements the
   * machine attaches to `draft -> requested` (a bound version, its hash, reviewers) gate the row.
   */
  async open(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: OpenApprovalInput,
  ): Promise<ApprovalRow> {
    const verdict = approvalStateMachine.transition('draft', 'requested', {
      deliverableVersionId: input.deliverableVersionId,
      contentHash: input.contentHash,
      reviewerIds: input.reviewerIds.length > 0 ? input.reviewerIds : null,
    });
    if (!verdict.ok) {
      throw new ApprovalTransitionError(
        'draft',
        'requested',
        verdict.reason,
        verdict.missing,
        verdict.detail,
      );
    }

    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(approvals)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: input.projectId,
        deliverableId: input.deliverableId,
        deliverableVersionId: input.deliverableVersionId,
        contentHash: input.contentHash,
        state: 'requested',
        policy: input.policy ?? 'all_required',
        reviewerIds: [...input.reviewerIds],
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    return this.requireById(runner, context, id);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalId: string,
  ): Promise<ApprovalRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.organizationId, context.organizationId), eq(approvals.id, approvalId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalId: string,
  ): Promise<ApprovalRow> {
    const found = await this.findById(runner, context, approvalId);
    if (!found) throw new ApprovalNotFoundError(approvalId);
    return found;
  }

  /**
   * The approval bound to one governed version — the client deep-link's decide target.
   *
   * The client route (FR-05) is version-addressed: it names the `deliverable_version_id` the
   * client projection was published for, not an approval id the client never sees. An approval is
   * opened over exactly one immutable version, so this resolves that version's approval; the newest
   * by creation is taken defensively, and the read is tenant-scoped so another tenant's row is
   * absent rather than visible — the same not-found the service maps to 404.
   */
  async findByVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<ApprovalRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          eq(approvals.deliverableVersionId, deliverableVersionId),
        ),
      )
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireByVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<ApprovalRow> {
    const found = await this.findByVersion(runner, context, deliverableVersionId);
    if (!found) throw new ApprovalNotFoundError(deliverableVersionId);
    return found;
  }

  /**
   * Move an approval through §8's lifecycle, writing the facts the move required.
   *
   * The current state is read inside the same unit of work and checked by the machine, then the
   * write re-states `version` — so a concurrent change (including another decision) loses rather
   * than slipping through a check made against a state it has since left. An already-terminal
   * approval has no outbound transition, so this refuses to re-decide one; the `0027` trigger is
   * the same rule at the engine.
   *
   * Only the columns the target state's requirements name are written. Nothing else is cleared.
   */
  async transition(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalId: string,
    expectedVersion: number,
    to: ApprovalState,
    facts: ApprovalDecisionFacts = {},
  ): Promise<ApprovalRow> {
    const current = await this.requireById(runner, context, approvalId);
    const from = current.state as ApprovalState;

    const verdict = approvalStateMachine.transition(from, to, {
      decidedByUserId: facts.decidedByUserId ?? null,
      decidedAt: facts.decidedAt ?? null,
      contentHash: facts.contentHash ?? null,
      feedback: facts.feedback ?? null,
      invalidationReason: facts.invalidationReason ?? null,
    });
    if (!verdict.ok) {
      throw new ApprovalTransitionError(from, to, verdict.reason, verdict.missing, verdict.detail);
    }

    const changes: Record<string, unknown> = {
      state: to,
      version: sql`version + 1`,
      updatedAt: new Date(),
    };
    if (facts.decidedByUserId !== undefined) changes['decidedByUserId'] = facts.decidedByUserId;
    if (facts.decidedAt !== undefined) changes['decidedAt'] = facts.decidedAt;
    if (facts.feedback !== undefined) changes['feedback'] = facts.feedback;
    if (facts.invalidationReason !== undefined) {
      changes['invalidationReason'] = facts.invalidationReason;
    }

    const result = await tenantDrizzle(runner)
      .update(approvals)
      .set(changes)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          eq(approvals.id, approvalId),
          eq(approvals.version, expectedVersion),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Wrong tenant, no such approval, or a stale token — a scoped read tells them apart, so a
      // caller in the wrong tenant still gets not-found rather than a conflict.
      const live = await this.findById(runner, context, approvalId);
      if (!live) throw new ApprovalNotFoundError(approvalId);
      throw new ApprovalVersionConflictError(approvalId, live.version);
    }

    return this.requireById(runner, context, approvalId);
  }
}
