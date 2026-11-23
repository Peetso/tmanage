import { uuidv7 } from '@tmanage/domain';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { isPlatformOp } from '../ai-actions/registry/index.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InternalGrantPayload } from './internal-grant.js';
import {
  PENDING_AI_ACTION_TTL_MS,
  approvalGateOf,
  approvalRequiredResult,
  approvalUrl,
  buildApprovalSummary,
  buildOpRequest,
  capResult,
  effectiveStatus,
  freezeConfirmAction,
  signRequestState,
  subjectFromBody,
  platformTargetLookup,
  subjectLookupOp,
  verifyFrozenAction,
} from './pending-actions.js';
import type {
  ApprovalConfirmation,
  ApprovalSummary,
  FrozenAction,
  OpRequest,
  PendingStatus,
} from './pending-actions.js';
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

/** The DI token {@link PendingAiActionsService} is provided under (`PendingAiActionsModule`). */
export const PENDING_AI_ACTIONS_SERVICE = Symbol.for('tmanage.PendingAiActionsService');

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
  /** `step_up`: money or HR, approved only with a fresh step-up (the panel shows "Review"). */
  readonly confirmation: ApprovalConfirmation;
  /** The amount a money approval types back; `null` when none is asked. */
  readonly amount: number | null;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

/** What the person brought to an approve: their step-up and the amount they typed. */
export interface ApprovalProof {
  /** Identity's decision (`isFreshStepUp`) for this request's session and user. */
  readonly stepUpFresh: boolean;
  readonly amount: number | undefined;
  /**
   * ADR-0015 F3: the approving request's own cookie session, set by the controller from request
   * state. A platform action runs bound to it (the step-up is checked at run time, not propose).
   */
  readonly sessionId?: string;
}

/** ADR-0015 F3: how an approved action runs. */
export interface ApproveOptions {
  /** The approving cookie session; a platform action runs bound to it. */
  readonly stepUpSessionId?: string;
}

/**
 * ADR-0015 F11 — at most this many platform proposals per person and AI client an hour, so a
 * tricked model cannot bury the admin in cards. Counted in this process (the API runs as one).
 */
export const PLATFORM_PROPOSALS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

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

/** The most waiting actions one list returns; the badge says "50 waiting" at most. */
export const PENDING_LIST_LIMIT = 50;

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'pending_ai_action_not_visible');

export class PendingAiActionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly execute: OpExecutor,
    private readonly repository: PendingAiActionsRepository = new PendingAiActionsRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** F11: platform proposals per `user:client`, fixed hourly window. */
  private readonly platformProposals = createFixedWindowLimiter({
    windowMs: HOUR_MS,
    max: PLATFORM_PROPOSALS_PER_HOUR,
  });

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
    if (
      isPlatformOp(frozen.op) &&
      !this.platformProposals(`${requester.userId}:${requester.clientId}`)
    ) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many platform changes were proposed this hour. Try again later.',
        undefined,
        'ai_platform_proposals_rate_limited',
      );
    }
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

  /**
   * The approve page's view of one of the signed-in member's own pending actions. While it is
   * pending, a target the arguments only name by id (a delete) is named by reading it as the
   * member, so the page can say what will go (`Delete “Homepage direction review”`).
   */
  async view(
    context: TenantContext,
    id: string,
    orgSlug?: string,
    /** ADR-0015 F9: the viewing cookie session, so a platform target can be named. */
    sessionId?: string,
  ): Promise<PendingAiActionView> {
    const found = await this.loadOwn(context, id);
    return this.named(context, orgSlug, found, this.toView(found), sessionId);
  }

  /** `view` with its target named by {@link readSubject} when the arguments did not name it. */
  private async named(
    context: TenantContext,
    orgSlug: string | undefined,
    found: PendingAiActionWithMember,
    view: PendingAiActionView,
    sessionId?: string,
  ): Promise<PendingAiActionView> {
    if (orgSlug === undefined || view.status !== 'pending' || view.summary.subject !== null) {
      return view;
    }
    const subject = await this.readSubject(context, orgSlug, found, sessionId);
    return subject === null ? view : { ...view, summary: { ...view.summary, subject } };
  }

  /**
   * The signed-in member's own actions still waiting for approval, newest first (55-15p): the
   * "AI actions" list and its waiting badge. Each row is named the way the approve page names it
   * (TESTUX P1 9: "Delete work item" alone does not say which), by the same registry read; the
   * frozen action itself never runs here. A row whose stored arguments no longer verify is left
   * out rather than failing the list.
   */
  async listPending(
    context: TenantContext,
    orgSlug?: string,
  ): Promise<{ items: PendingAiActionView[] }> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listOwnPending(
        runner,
        context,
        this.owner(context),
        this.now(),
        PENDING_LIST_LIMIT,
      ),
    );
    const views: Promise<PendingAiActionView>[] = [];
    for (const found of rows) {
      try {
        views.push(this.named(context, orgSlug, found, this.toView(found)));
      } catch {
        // Tampered or unknown op: never shown as approvable.
      }
    }
    return { items: await Promise.all(views) };
  }

  /**
   * Approve and run. Only the request that wins the guarded `pending → approved` transition runs
   * the op; a second approve, an expired request or a declined one returns the current state and
   * runs nothing (`T-APR-03`). The stored args are re-verified against their hash first.
   */
  async approve(
    context: TenantContext,
    orgSlug: string,
    id: string,
    options: ApproveOptions = {},
  ): Promise<PendingAiActionView> {
    const found = await this.loadOwn(context, id);
    const frozen = verifyFrozenAction(found.row.opId, found.row.argsJson, found.row.argsSha256);
    if (frozen === undefined) throw notFound();
    const owner = this.owner(context);
    const won = await this.database.transaction(context, (tx) =>
      this.repository.decide(tx, context, owner, id, 'approved', this.now()),
    );
    if (won === 1) {
      const outcome = await this.runFrozen(context, orgSlug, found, frozen, options);
      await this.database.transaction(context, (tx) =>
        this.repository.recordResult(tx, context, id, outcome),
      );
    }
    return this.toView(await this.loadOwn(context, id));
  }

  /**
   * The approve route's entry (AI panel gap 3): a money or HR action is refused without a fresh
   * step-up (403 `reauthentication_required`) and, when it names an amount, without that amount
   * typed back (400). The screen is not the control: a bare `POST …/approve` gets the same refusal.
   * Checked only while the action is still pending; a decided or expired one runs nothing anyway.
   */
  async approveInPerson(
    context: TenantContext,
    orgSlug: string,
    id: string,
    proof: ApprovalProof,
  ): Promise<PendingAiActionView> {
    const found = await this.loadOwn(context, id);
    const frozen = verifyFrozenAction(found.row.opId, found.row.argsJson, found.row.argsSha256);
    if (frozen === undefined) throw notFound();
    if (effectiveStatus(found.row, this.now()) === 'pending') {
      const gate = approvalGateOf(frozen.op, frozen.args);
      if (gate.confirmation === 'step_up' && !proof.stepUpFresh) {
        throw new ApiError(
          403,
          'reauthentication_required',
          'Confirm it is you to approve this.',
          undefined,
          'ai_approval_step_up',
        );
      }
      if (gate.amount !== null && proof.amount !== gate.amount) {
        throw new ApiError(
          400,
          'validation_failed',
          'The amount does not match.',
          [{ field: 'amount', message: 'type the amount the card shows' }],
          'ai_approval_amount_mismatch',
        );
      }
    }
    return this.approve(
      context,
      orgSlug,
      id,
      proof.sessionId !== undefined ? { stepUpSessionId: proof.sessionId } : {},
    );
  }

  /**
   * AI panel: how many of the member's own actions wait, counted exactly as {@link listPending}
   * lists them (a row whose arguments no longer verify is left out), without naming any.
   */
  async countPending(context: TenantContext): Promise<number> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listOwnPending(
        runner,
        context,
        this.owner(context),
        this.now(),
        PENDING_LIST_LIMIT,
      ),
    );
    return rows.filter(
      ({ row }) => verifyFrozenAction(row.opId, row.argsJson, row.argsSha256) !== undefined,
    ).length;
  }

  /** Decline. A no-op on anything no longer pending. */
  async decline(context: TenantContext, id: string): Promise<PendingAiActionView> {
    await this.loadOwn(context, id);
    await this.database.transaction(context, (tx) =>
      this.repository.decide(tx, context, this.owner(context), id, 'declined', this.now()),
    );
    return this.toView(await this.loadOwn(context, id));
  }

  /**
   * Name the target by running the registry's read of the same path as the member. A read only,
   * never the frozen action; any failure leaves the bold line out rather than failing the page.
   */
  private async readSubject(
    context: TenantContext,
    orgSlug: string,
    found: PendingAiActionWithMember,
    sessionId?: string,
  ): Promise<string | null> {
    const frozen = verifyFrozenAction(found.row.opId, found.row.argsJson, found.row.argsSha256);
    if (frozen === undefined) return null;
    // F9: a platform target (company or person) is named by the platform read, bound to the
    // viewing session; any other op by the registry read of the same path.
    const platform = platformTargetLookup(frozen.op, frozen.args);
    if (platform !== undefined && sessionId === undefined) return null;
    const read = platform?.op ?? subjectLookupOp(frozen.op);
    if (read === undefined) return null;
    try {
      const pathArgs =
        platform?.args ??
        Object.fromEntries(
          Object.entries(frozen.args).filter(([key]) => read.path.includes(`:${key}`)),
        );
      const response = await this.execute(
        buildOpRequest(read, pathArgs, orgSlug),
        {
          grantId: `approval:${found.row.id}:subject`,
          userId: context.userId,
          membershipId: context.membershipId,
          organizationId: context.organizationId,
          clientId: found.row.clientId,
          clientName: found.row.clientName,
          opId: read.id,
          ...(platform !== undefined && sessionId !== undefined
            ? { stepUpSessionId: sessionId }
            : {}),
        },
        context.correlationId,
      );
      return response.status === 200 ? subjectFromBody(response.body) : null;
    } catch {
      return null;
    }
  }

  private async runFrozen(
    context: TenantContext,
    orgSlug: string,
    found: PendingAiActionWithMember,
    frozen: FrozenAction,
    options: ApproveOptions = {},
  ): Promise<{ status: number; body: unknown }> {
    // ADR-0015 F3/F10: a platform action runs as an internal grant bound to the APPROVING cookie
    // session (its step-up is checked now, at run time) and names the pending action it executes.
    const platform =
      isPlatformOp(frozen.op) && options.stepUpSessionId !== undefined
        ? { stepUpSessionId: options.stepUpSessionId, pendingActionId: found.row.id }
        : {};
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
          ...platform,
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
    const gate = approvalGateOf(frozen.op, frozen.args);
    return {
      id: row.id,
      status: effectiveStatus(row, this.now()),
      clientName: row.clientName,
      memberName: found.memberName,
      memberEmail: found.memberEmail,
      summary: buildApprovalSummary(frozen.op, frozen.detail, frozen.args),
      confirmation: gate.confirmation,
      amount: gate.amount,
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
