import { uuidv7 } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InternalGrantPayload } from './internal-grant.js';
import {
  PENDING_AI_ACTION_TTL_MS,
  approvalRequiredResult,
  approvalUrl,
  buildApprovalSummary,
  buildOpRequest,
  capResult,
  effectiveStatus,
  freezeConfirmAction,
  signRequestState,
  verifyFrozenAction,
} from './pending-actions.js';
import type { ApprovalSummary, FrozenAction, OpRequest, PendingStatus } from './pending-actions.js';
import { PendingAiActionsRepository } from './pending-actions.repository.js';
import type { PendingAiActionWithMember } from './pending-actions.repository.js';

/**
 * **Pending AI actions — the application service (MCP connector S10, architecture F3).**
 *
 * Two callers:
 *
 *  - **The MCP side** ({@link request}, {@link check}): an AI client asked for a confirm-class op.
 *    The op is validated and frozen into a row; nothing runs. A later retry or
 *    `tmanage_check_approval` reads the outcome.
 *  - **The approve page** ({@link view}, {@link approve}, {@link decline}): the member, signed in
 *    with a cookie session, sees exactly what will happen and decides. Approve wins the single
 *    guarded transition and then runs the frozen op on the server, once, through
 *    {@link OpExecutor} — an in-process inject under a one-time internal grant for the same
 *    member, so the op passes the full guard chain as that member and is attributed to the AI
 *    client.
 *
 * Every member-facing read names the organization, the membership and the user: another member,
 * or the same person in another org, gets the same 404 as an id that never existed (`T-APR-02`).
 */

/** Runs one frozen op in-process as the given principal; returns its status and raw body. */
export type OpExecutor = (
  request: OpRequest,
  grant: InternalGrantPayload,
  correlationId: string,
) => Promise<{ readonly status: number; readonly body: string }>;

/** What the AI client is attributed as when it asks for an action. */
export interface PendingActionRequester {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly clientName: string;
}

/** What the approve page receives. No arguments beyond the server-built summary, no result body. */
export interface PendingAiActionView {
  readonly id: string;
  readonly status: PendingStatus;
  readonly clientName: string;
  readonly memberName: string;
  readonly memberEmail: string;
  readonly summary: ApprovalSummary;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

export interface CreatedPendingAction {
  readonly id: string;
  readonly title: string;
  readonly expiresAt: Date;
}

export interface PendingActionOutcome {
  readonly status: PendingStatus;
  readonly resultStatus: number | null;
  readonly result: unknown;
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'pending_ai_action_not_visible');

export class PendingAiActionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly execute: OpExecutor,
    private readonly repository: PendingAiActionsRepository = new PendingAiActionsRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Freeze a confirm-class op for approval. Runs on the MCP path, before any tenant context, so
   * it writes under a service context for the requester's own organization; the membership and
   * user come from the authenticated grant, never from the AI's arguments.
   */
  async request(
    requester: PendingActionRequester,
    opId: string,
    args: unknown,
    correlationId: string,
  ): Promise<CreatedPendingAction> {
    const frozen = freezeConfirmAction(opId, args);
    const now = this.now();
    const id = uuidv7();
    const expiresAt = new Date(now.getTime() + PENDING_AI_ACTION_TTL_MS);
    const context = this.serviceContext(requester.organizationId, correlationId);
    await this.database.transaction(context, (tx) =>
      this.repository.insert(tx, context, {
        id,
        membershipId: requester.membershipId,
        userId: requester.userId,
        clientId: requester.clientId,
        clientName: requester.clientName,
        opId: frozen.op.id,
        args: frozen.args,
        argsSha256: frozen.argsSha256,
        expiresAt,
        createdAt: now,
      }),
    );
    return { id, title: frozen.detail.title, expiresAt };
  }

  /** The outcome for the AI client's retry / `tmanage_check_approval`. Own actions only. */
  async check(
    requester: PendingActionRequester,
    id: string,
    correlationId: string,
  ): Promise<PendingActionOutcome> {
    const context = this.serviceContext(requester.organizationId, correlationId);
    const found = await this.database.read(context, (runner) =>
      this.repository.findOwn(runner, context, requester, id),
    );
    if (found === undefined) throw notFound();
    return {
      status: effectiveStatus(found.row, this.now()),
      resultStatus: found.row.resultStatus ?? null,
      result: found.row.resultJson ?? null,
    };
  }

  /** The approve page's view of one of the signed-in member's own pending actions. */
  async view(context: TenantContext, id: string): Promise<PendingAiActionView> {
    return this.toView(await this.loadOwn(context, id));
  }

  /**
   * Approve and run. Only the request that wins the guarded `pending → approved` transition runs
   * the op; a second approve, an expired request or a declined one returns the current state and
   * runs nothing (`T-APR-03`). The stored args are re-verified against their hash first.
   */
  async approve(context: TenantContext, orgSlug: string, id: string): Promise<PendingAiActionView> {
    const found = await this.loadOwn(context, id);
    const frozen = verifyFrozenAction(found.row.opId, found.row.argsJson, found.row.argsSha256);
    if (frozen === undefined) throw notFound();
    const owner = this.owner(context);
    const won = await this.database.transaction(context, (tx) =>
      this.repository.decide(tx, context, owner, id, 'approved', this.now()),
    );
    if (won === 1) {
      const outcome = await this.runFrozen(context, orgSlug, found, frozen);
      await this.database.transaction(context, (tx) =>
        this.repository.recordResult(tx, context, id, outcome),
      );
    }
    return this.view(context, id);
  }

  /** Decline. A no-op on anything no longer pending. */
  async decline(context: TenantContext, id: string): Promise<PendingAiActionView> {
    await this.loadOwn(context, id);
    await this.database.transaction(context, (tx) =>
      this.repository.decide(tx, context, this.owner(context), id, 'declined', this.now()),
    );
    return this.view(context, id);
  }

  private async runFrozen(
    context: TenantContext,
    orgSlug: string,
    found: PendingAiActionWithMember,
    frozen: FrozenAction,
  ): Promise<{ status: number; body: unknown }> {
    const request = buildOpRequest(frozen.op, frozen.args, orgSlug);
    try {
      const response = await this.execute(
        request,
        {
          grantId: `approval:${found.row.id}`,
          userId: context.userId,
          membershipId: context.membershipId,
          organizationId: context.organizationId,
          clientId: found.row.clientId,
          clientName: found.row.clientName,
          opId: frozen.op.id,
        },
        context.correlationId,
      );
      return { status: response.status, body: capResult(response.body) };
    } catch {
      return { status: 500, body: null };
    }
  }

  private async loadOwn(context: TenantContext, id: string): Promise<PendingAiActionWithMember> {
    const found = await this.database.read(context, (runner) =>
      this.repository.findOwn(runner, context, this.owner(context), id),
    );
    if (found === undefined) throw notFound();
    return found;
  }

  private toView(found: PendingAiActionWithMember): PendingAiActionView {
    const { row } = found;
    const frozen = verifyFrozenAction(row.opId, row.argsJson, row.argsSha256);
    if (frozen === undefined) throw notFound();
    return {
      id: row.id,
      status: effectiveStatus(row, this.now()),
      clientName: row.clientName,
      memberName: found.memberName,
      memberEmail: found.memberEmail,
      summary: buildApprovalSummary(frozen.op, frozen.detail, frozen.args),
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }

  private owner(context: TenantContext): { membershipId: string; userId: string } {
    return { membershipId: context.membershipId, userId: context.userId };
  }

  private serviceContext(organizationId: string, correlationId: string): TenantContext {
    return createServiceContext({
      organizationId,
      correlationId,
      policyVersion: 'pending-ai-actions',
    });
  }
}

/** What the MCP runtime needs to answer a confirm-class call (architecture F3). */
export interface ApprovalAnswerOptions {
  readonly webOrigin: string;
  readonly orgSlug: string;
  /** The HMAC key the `requestState` is signed with. */
  readonly stateKey: string;
  readonly supportsUrlElicitation: boolean;
  readonly correlationId: string;
}

/**
 * The glue `tmanage_run_action` (and a full-profile confirm-class tool) calls: freeze the action,
 * then answer with MRTR URL elicitation or the link fallback. Nothing runs here.
 */
export async function answerWithApproval(
  service: PendingAiActionsService,
  requester: PendingActionRequester,
  opId: string,
  args: unknown,
  options: ApprovalAnswerOptions,
): Promise<Record<string, unknown>> {
  const created = await service.request(requester, opId, args, options.correlationId);
  return approvalRequiredResult({
    id: created.id,
    url: approvalUrl(options.webOrigin, options.orgSlug, created.id),
    expiresAt: created.expiresAt,
    title: created.title,
    supportsUrlElicitation: options.supportsUrlElicitation,
    requestState: signRequestState(created.id, options.stateKey),
  });
}
