import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { verifyReauthToken } from '../identity/reauth-token.js';
import type { AiBudgetService } from './ai-budget.service.js';
import { currentValues, readTarget, runOp, runChange } from './ai-change.js';
import { billingCardAmount } from './packs/billing.js';
import {
  AiChangeRepository,
  type AiChangeState,
  type AiChangeStateName,
} from './ai-change.repository.js';
import {
  amountOf,
  changeGateFor,
  validateChange,
  verifyCard,
  type ValidatedChange,
} from './ai-preview.js';
import { AI_UNDO_WINDOW_MS, changedSince, recordOf, withinUndoWindow } from './ai-undo.js';
import type { AiUndoEntry } from './ai-undo.js';
import {
  chatScopesFor,
  openStanding,
  type ChatStanding,
  type ChatSurface,
  type ChatSurfaceInput,
  type ChatToolResult,
} from './copilot-chat.service.js';

/**
 * 62-11 part 2 (plan 62 §4.3, J3) — the member's side of an AI change: **confirm** a preview card
 * and **undo** a change.
 *
 * **Confirm** — by the same member, signed in, within 10 minutes; runs once:
 * 1. The signed card is verified (HMAC), bound to this organization, membership and user, not
 *    expired. Each item's arguments are re-validated by the op's schema and must hash to the
 *    frozen hash: what runs is exactly what the card showed.
 * 2. Money and HR items need a fresh step-up (`x-reauth-token`, the finance send's own check) and
 *    the amount typed back; an amount the card cannot name is refused (fail closed). The
 *    workspace's approval rules are the op's own route's, which the change passes through.
 * 3. The card is claimed (`card → confirming`, one guarded UPDATE): a second confirm loses.
 * 4. The items run in order through the member's surface, their undo captured; a confirm-class
 *    item runs by approving its `pending_ai_actions` row (same member, frozen args, once). The
 *    first failure stops the rest.
 *
 * **Audit, fail closed (OWASP ASVS 5.0 V16, security logging):** the `ai_change.confirmed` row is
 * written in the same transaction as the claim, before anything runs; if it cannot be written the
 * claim rolls back and nothing changes. The outcomes follow in `ai_change.applied`, written with
 * the final state move. Undo likewise: `ai_change.undone` with the `done → undoing` claim, before
 * any inverse runs, then `ai_change.applied` (kind `undo`). Each changed record also carries its
 * own route's audit row, written by that route in the change's own transaction.
 *
 * **Undo** — within 15 minutes of the change, by the same member: refused when the task has a
 * change without an inverse, or when any record changed since (checked for all before anything
 * runs); claimed (`done → undoing`); the inverses run newest first; the task's credits are refunded
 * (`AiBudgetService.refundTask`: 5 a day per member).
 */

export const AI_CHANGE_CONFIRMED_AUDIT_ACTION = 'ai_change.confirmed';
export const AI_CHANGE_UNDONE_AUDIT_ACTION = 'ai_change.undone';
export const AI_CHANGE_APPLIED_AUDIT_ACTION = 'ai_change.applied';
/** A change the AI ran at once (owner setting), recorded before it ran (fail closed). */
export const AI_CHANGE_RAN_AT_ONCE_AUDIT_ACTION = 'ai_change.ran_at_once';

/** A step-up proves the password within the last 15 minutes (the finance send's window). */
export interface ConfirmMeta {
  readonly reauthToken: string | undefined;
  readonly sessionId: string | undefined;
}

export interface ConfirmInput {
  readonly card: string;
  /** The amounts the member typed back, by card item index. */
  readonly amounts: Readonly<Record<number, number>>;
}

/** The request body, parsed at the boundary (IP-2). */
export function parseConfirmBody(body: Readonly<Record<string, unknown>> | null): ConfirmInput {
  const card = body?.['card'];
  if (typeof card !== 'string' || card === '') {
    throw new ApiError(400, 'validation_failed', 'Send back the card you confirm.', [
      { field: 'card', message: 'the card of the preview' },
    ]);
  }
  const raw = body?.['amounts'];
  const amounts: Record<number, number> = {};
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ApiError(400, 'validation_failed', 'Type the amounts again.', [
        { field: 'amounts', message: 'an object of item index to amount' },
      ]);
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || typeof value !== 'number') {
        throw new ApiError(400, 'validation_failed', 'Type the amounts again.', [
          { field: 'amounts', message: 'an object of item index to amount' },
        ]);
      }
      amounts[index] = value;
    }
  }
  return { card, amounts };
}

export type ConfirmedItemOutcome = 'done' | 'failed' | 'not_run';

export interface AiConfirmView {
  readonly taskId: string;
  readonly items: readonly {
    readonly index: number;
    readonly opId: string;
    readonly outcome: ConfirmedItemOutcome;
  }[];
  /** Until when the changes can be undone; `null` when they cannot. */
  readonly undoUntil: string | null;
  readonly cannotBeUndone: boolean;
}

export interface AiUndoView {
  readonly taskId: string;
  readonly state: 'undone' | 'failed';
  readonly refundedCredits: number;
}

/** The pending AI actions a confirm-class card item is approved through. */
export interface ChangeApprovals {
  approve(context: TenantContext, orgSlug: string, id: string): Promise<void>;
  outcome(
    context: TenantContext,
    id: string,
  ): Promise<{
    readonly status: string;
    readonly resultStatus: number | null;
    readonly result: unknown;
  }>;
}

export interface AiChangeDeps {
  readonly database: TenantDatabase;
  readonly standing: (context: TenantContext) => Promise<ChatStanding>;
  readonly surface: (input: ChatSurfaceInput) => ChatSurface;
  readonly budget: Pick<AiBudgetService, 'refundTask'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly approvals?: ChangeApprovals;
  /** The key cards are signed with; absent = no card can be confirmed. */
  readonly cardKey?: string;
  /** The session secret the step-up token is signed with; absent = no money/HR confirm. */
  readonly sessionSecret?: string;
  readonly repository?: AiChangeRepository;
  readonly now?: () => Date;
}

const notFound = (auditCode: string) =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
const conflict = (message: string, auditCode: string) =>
  new ApiError(409, 'conflict', message, undefined, auditCode);

export class AiChangeService {
  private readonly repository: AiChangeRepository;
  private readonly now: () => Date;

  constructor(private readonly deps: AiChangeDeps) {
    this.repository = deps.repository ?? new AiChangeRepository();
    this.now = deps.now ?? (() => new Date());
  }

  async confirm(
    context: TenantContext,
    orgSlug: string,
    input: ConfirmInput,
    meta: ConfirmMeta,
  ): Promise<AiConfirmView> {
    const standing = await this.writable(context);
    const key = this.deps.cardKey;
    const payload = key === undefined ? null : verifyCard(input.card, key);
    if (
      payload === null ||
      payload.organizationId !== context.organizationId ||
      payload.membershipId !== context.membershipId ||
      payload.userId !== context.userId
    ) {
      throw notFound('ai_card_invalid');
    }
    if (this.now().getTime() > payload.expiresAt) {
      throw conflict('This preview expired. Ask again.', 'ai_card_expired');
    }
    const changes: ValidatedChange[] = payload.items.map((item) => {
      const change = validateChange(item.opId, item.args);
      if (change === null || change.argsSha256 !== item.argsSha256)
        throw notFound('ai_card_altered');
      if (change.op.risk === 'confirm' && item.approvalId === null)
        throw notFound('ai_card_altered');
      return change;
    });
    const surface = this.surfaceFor(context, orgSlug, standing, payload.taskId);
    await this.checkSensitive(context, surface, changes, input, meta);

    const before = await this.readState(context, payload.taskId);
    // The claim and its audit row commit together, before anything runs (fail closed, V16).
    const claimed = await this.deps.database.transaction(context, async (tx) => {
      const won = await this.repository.claimCard(tx, context, payload.taskId, payload.cardId, {
        ...before,
        state: 'confirming',
      });
      if (!won) return false;
      await this.deps.audit.record(tx, context, {
        action: AI_CHANGE_CONFIRMED_AUDIT_ACTION,
        result: 'allowed',
        objectId: payload.taskId,
        actorUserId: context.userId,
        metadata: { client_id: 'tmanage-ai', ops: changes.map((c) => c.op.id) },
      });
      return true;
    });
    if (!claimed) throw conflict('This preview was already confirmed.', 'ai_card_used');

    const outcomes: ConfirmedItemOutcome[] = changes.map(() => 'not_run');
    const entries: AiUndoEntry[] = [...before.entries];
    let cannotUndo = before.cannotUndo;
    for (const [index, change] of changes.entries()) {
      const approvalId = payload.items[index]!.approvalId;
      const approve =
        approvalId === null ? undefined : () => this.approveFrozen(context, orgSlug, approvalId);
      const ran = await runChange(surface, change, approve);
      outcomes[index] = ran.ok ? 'done' : 'failed';
      if (!ran.ok) break;
      if (ran.undo === null) cannotUndo = true;
      else entries.push(ran.undo);
    }
    const anyRan = outcomes.includes('done');
    const doneAt = anyRan ? this.now() : null;
    const final: AiChangeState = {
      v: 1,
      state: anyRan ? 'done' : 'confirm_failed',
      card: null,
      doneAt: doneAt === null ? before.doneAt : doneAt.toISOString(),
      entries,
      cannotUndo,
    };
    await this.deps.database.transaction(context, async (tx) => {
      await this.repository.move(tx, context, payload.taskId, 'confirming', final);
      await this.deps.audit.record(tx, context, {
        action: AI_CHANGE_APPLIED_AUDIT_ACTION,
        result: anyRan ? 'allowed' : 'denied',
        objectId: payload.taskId,
        actorUserId: context.userId,
        metadata: {
          client_id: 'tmanage-ai',
          kind: 'confirm',
          ops: changes.map((c) => c.op.id),
          outcomes,
        },
      });
    });
    return {
      taskId: payload.taskId,
      items: changes.map((c, index) => ({ index, opId: c.op.id, outcome: outcomes[index]! })),
      undoUntil:
        final.doneAt === null || cannotUndo || entries.length === 0
          ? null
          : new Date(Date.parse(final.doneAt) + AI_UNDO_WINDOW_MS).toISOString(),
      cannotBeUndone: cannotUndo || entries.length === 0,
    };
  }

  async undo(context: TenantContext, orgSlug: string, taskId: string): Promise<AiUndoView> {
    const standing = await this.writable(context);
    const row = await this.deps.database.read(context, (runner) =>
      this.repository.read(runner, context, taskId),
    );
    if (row === null) throw notFound('ai_undo_task_not_visible');
    const state = row.change;
    if (
      state === null ||
      state.state !== 'done' ||
      state.entries.length === 0 ||
      state.cannotUndo ||
      state.doneAt === null ||
      (row.status !== 'completed' && row.status !== 'failed')
    ) {
      throw conflict('This change cannot be undone.', 'ai_undo_not_available');
    }
    if (!withinUndoWindow(new Date(state.doneAt), this.now())) {
      throw conflict('Undo is no longer available for this change.', 'ai_undo_expired');
    }
    const surface = this.surfaceFor(context, orgSlug, standing, taskId);
    // Every record must still be as the AI left it, before anything runs.
    for (const entry of state.entries) {
      const current = await readTarget(surface, entry.readOpId, entry.readArgs);
      if (changedSince(entry, current)) {
        throw conflict(
          'Someone changed this since, so it cannot be undone automatically.',
          'ai_undo_record_changed',
        );
      }
    }
    // The claim and its audit row commit together, before any inverse runs (fail closed, V16).
    const claimed = await this.deps.database.transaction(context, async (tx) => {
      const won = await this.repository.move(tx, context, taskId, 'done', {
        ...state,
        state: 'undoing',
      });
      if (!won) return false;
      await this.deps.audit.record(tx, context, {
        action: AI_CHANGE_UNDONE_AUDIT_ACTION,
        result: 'allowed',
        objectId: taskId,
        actorUserId: context.userId,
        metadata: { client_id: 'tmanage-ai', ops: state.entries.map((e) => e.opId) },
      });
      return true;
    });
    if (!claimed) throw conflict('This change is already being undone.', 'ai_undo_in_progress');

    let failed = false;
    for (const entry of [...state.entries].reverse()) {
      const ran = await runOp(surface, entry.inverseOpId, entry.inverseArgs);
      if (ran.isError === true) {
        failed = true;
        break;
      }
    }
    const next: AiChangeStateName = failed ? 'undo_failed' : 'undone';
    await this.deps.database.transaction(context, async (tx) => {
      await this.repository.move(tx, context, taskId, 'undoing', { ...state, state: next });
      await this.deps.audit.record(tx, context, {
        action: AI_CHANGE_APPLIED_AUDIT_ACTION,
        result: failed ? 'denied' : 'allowed',
        objectId: taskId,
        actorUserId: context.userId,
        metadata: {
          client_id: 'tmanage-ai',
          kind: 'undo',
          ops: state.entries.map((e) => e.opId),
          outcomes: [failed ? 'failed' : 'done'],
        },
      });
    });
    if (failed) return { taskId, state: 'failed', refundedCredits: 0 };
    // Undone work is not charged (plan §5); a failed turn was never charged.
    let refundedCredits = 0;
    if (row.status === 'completed') {
      const refund = await this.deps.budget.refundTask(context, taskId);
      if (refund.ok) refundedCredits = refund.value.refundedCredits;
    }
    return { taskId, state: 'undone', refundedCredits };
  }

  /** The gates, plus the owner's write setting: changes need `read_write`. */
  private async writable(context: TenantContext): Promise<ChatStanding> {
    const standing = await openStanding(context, this.deps.standing);
    if (standing.writeScope !== 'read_write') {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'ai_change_read_only');
    }
    return standing;
  }

  private surfaceFor(
    context: TenantContext,
    orgSlug: string,
    standing: ChatStanding,
    taskId: string,
  ): ChatSurface {
    return this.deps.surface({
      context,
      orgSlug,
      scopes: chatScopesFor(standing.writeScope),
      grantId: taskId,
      idempotencyKey: () => null,
    });
  }

  /** Money and HR: a fresh step-up, and for money the amount typed back. */
  private async checkSensitive(
    context: TenantContext,
    surface: ChatSurface,
    changes: readonly ValidatedChange[],
    input: ConfirmInput,
    meta: ConfirmMeta,
  ): Promise<void> {
    // Sensitivity alone decides step-up and the typed amount; the undo does not change them.
    const gates = changes.map((change) =>
      changeGateFor(change.op, { runAtOnce: false, hasUndo: false }),
    );
    if (gates.some((gate) => gate?.stepUp === true) && !this.stepUpFresh(context, meta)) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to make this change.',
        undefined,
        'ai_card_step_up',
      );
    }
    for (const [index, change] of changes.entries()) {
      if (gates[index]?.typedAmount !== true) continue;
      const current = recordOf(await currentValues(surface, change));
      // 62-29: the op's own rule first (a pull's total is recomputed now), else the general one.
      const decided = await billingCardAmount(change.op.id, change.args, current, (id, args) =>
        readTarget(surface, id, args),
      );
      const amount = decided !== undefined ? decided : amountOf(change.args, current);
      if (amount === null) {
        throw conflict('Make this change in TManage directly.', 'ai_card_amount_unknown');
      }
      if (input.amounts[index] !== amount) {
        throw new ApiError(
          400,
          'validation_failed',
          'The amount does not match.',
          [{ field: `amounts.${index}`, message: 'type the amount the card shows' }],
          'ai_card_amount_mismatch',
        );
      }
    }
  }

  private stepUpFresh(context: TenantContext, meta: ConfirmMeta): boolean {
    const secret = this.deps.sessionSecret;
    if (secret === undefined || meta.sessionId === undefined) return false;
    const verified = verifyReauthToken(meta.reauthToken, secret, this.now().getTime());
    return (
      verified.ok &&
      verified.claims.userId === context.userId &&
      verified.claims.sessionId === meta.sessionId
    );
  }

  /** Approve a confirm-class item's frozen row and read its outcome back as a tool result. */
  private async approveFrozen(
    context: TenantContext,
    orgSlug: string,
    approvalId: string,
  ): Promise<ChatToolResult> {
    const approvals = this.deps.approvals;
    if (approvals === undefined) return { isError: true, data: 'Approvals are not available.' };
    await approvals.approve(context, orgSlug, approvalId);
    const outcome = await approvals.outcome(context, approvalId);
    const ok =
      outcome.status === 'approved' &&
      outcome.resultStatus !== null &&
      outcome.resultStatus >= 200 &&
      outcome.resultStatus < 300;
    return ok ? { data: outcome.result } : { isError: true, data: `The action ${outcome.status}.` };
  }

  private async readState(context: TenantContext, taskId: string): Promise<AiChangeState> {
    const row = await this.deps.database.read(context, (runner) =>
      this.repository.read(runner, context, taskId),
    );
    const state = row?.change;
    if (row === null || state === null || state === undefined || state.state !== 'card') {
      throw conflict('This preview was already confirmed.', 'ai_card_used');
    }
    return state;
  }
}
