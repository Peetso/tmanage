import type { WorkflowConditionOp } from '../../common/database/schema.js';

/**
 * Automations & integrations (module 17, x190). The pure, deterministic evaluator behind a workflow
 * condition.
 *
 * ## What this is for
 *
 * x162 defined a template, x163 ran one — but every step ran unconditionally: there was no condition
 * model. A condition is a `(field, op, value)` predicate bound to a `target_step`. The run evaluator
 * (x163) reads a template's conditions and, for each step, fires it only when its condition holds. This
 * function is that decision, isolated: given one condition and a sample event, does the step fire?
 *
 * ## Pure and self-contained
 *
 * No I/O, no clock, no randomness — the same condition and event always produce the same boolean. The
 * operator set is the closed application allowlist (`WORKFLOW_CONDITION_OPS`); `evaluateCondition`
 * takes an already-validated `op`, so an off-list operator never reaches here (the controller rejects it
 * with a 400 before any write). A missing field, or a non-numeric value under a numeric operator,
 * evaluates to `false` — a step never fires on an ambiguous comparison.
 */

/** The shape the evaluator compares against an event: an already-validated condition predicate. */
export interface ConditionPredicate {
  readonly field: string;
  readonly op: WorkflowConditionOp;
  readonly value: string;
}

/** A sample event is a flat bag of fields the predicate reads by name. */
export type ConditionEvent = Record<string, unknown>;

/**
 * Evaluate one condition against a sample event. Deterministic and total: an absent field or a
 * non-numeric operand under `gt`/`lt` yields `false` rather than throwing, so a malformed event can
 * never make a step fire by accident.
 */
export function evaluateCondition(condition: ConditionPredicate, event: ConditionEvent): boolean {
  const present = Object.prototype.hasOwnProperty.call(event, condition.field);
  if (!present) return false;

  const actual = event[condition.field];

  switch (condition.op) {
    case 'eq':
      return toComparableString(actual) === condition.value;
    case 'neq':
      return toComparableString(actual) !== condition.value;
    case 'gt':
    case 'lt': {
      const left = Number(actual);
      const right = Number(condition.value);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      return condition.op === 'gt' ? left > right : left < right;
    }
    case 'contains':
      return toComparableString(actual).includes(condition.value);
  }
}

/**
 * A stable string view of an event value for the string operators. `null`/`undefined` compare as the
 * empty string; objects are not stringified into a comparable token (they compare as empty), because a
 * condition value is a scalar and comparing against `[object Object]` would be a silent surprise.
 */
function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}
