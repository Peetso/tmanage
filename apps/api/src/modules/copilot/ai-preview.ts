import { sensitivityOf } from '../ai-actions/registry/index.js';
import type { AiActionOp, Sensitivity } from '../ai-actions/registry/index.js';

/**
 * 62-11 (plan 62 §4.3), part 1 — the gate of one AI-proposed change, decided once from the op's
 * risk and sensitivity and the owner's "run at once" setting (AR-8: one decision, one place).
 *
 * - Every change is two-step by default: a preview card the same member confirms.
 * - **Run at once** (owner setting, default off) skips the card only for a `write`-class op with
 *   sensitivity `none` that has an undo. `confirm`-class ops always ask.
 * - `external` and `destructive` always show a card.
 * - `money` and `hr` also need a fresh step-up, the amount typed by the member (money) and the
 *   workspace's approval rule; they are never run at once and never confirmed by voice (62-16).
 * - An op without an undo says "cannot be undone" on its card.
 *
 * The preview card, the frozen-arguments confirm and the undo inverses are part 2 of this slice.
 */

export interface AiChangeGate {
  readonly sensitivity: Sensitivity;
  /** A preview card the member confirms before anything runs. */
  readonly card: boolean;
  readonly stepUp: boolean;
  /** The member types the amount the card shows (money only). */
  readonly typedAmount: boolean;
  /** The workspace's approval rule applies (money and HR). */
  readonly approvalRule: boolean;
  /** The card says the change cannot be undone. */
  readonly cannotBeUndone: boolean;
}

export interface AiChangeGateInput {
  /** `ai_workspace_settings.run_at_once` (owner setting). */
  readonly runAtOnce: boolean;
  /** The op declares an inverse (62-11 part 2, `ai-undo.ts`). */
  readonly hasUndo: boolean;
}

/** The gate of one change, or `null` for a read (reads never need one). */
export function changeGateFor(
  op: Pick<AiActionOp, 'id' | 'risk'>,
  input: AiChangeGateInput,
): AiChangeGate | null {
  if (op.risk === 'read') return null;
  const sensitivity = sensitivityOf(op);
  const sensitive = sensitivity === 'money' || sensitivity === 'hr';
  const runsAtOnce =
    input.runAtOnce && input.hasUndo && op.risk === 'write' && sensitivity === 'none';
  return {
    sensitivity,
    card: !runsAtOnce,
    stepUp: sensitive,
    typedAmount: sensitivity === 'money',
    approvalRule: sensitive,
    cannotBeUndone: !input.hasUndo,
  };
}
