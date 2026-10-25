/**
 * Automations (module 17, x190 / C1) — the pure decision "does this rule fire for this event?".
 *
 * A **condition** is a `(field, op, value)` predicate saved on a rule. The rule page writes one per
 * "Only if" chip and never edits it: changing a chip appends a newer condition on the same field,
 * so the **newest condition per field is the one in force**, and `contains ''` is the chip's
 * "any" value. A rule fires only when every field's condition in force holds; a rule with no
 * conditions always fires.
 *
 * Shared by the API (manual tests) and the worker (rules firing on their trigger), so both read the
 * same rule the same way. No I/O, no clock: the same conditions and event give the same answer.
 */

/** The closed operator set — mirrors the API's `WORKFLOW_CONDITION_OPS` allowlist. */
export type AutomationConditionOp = 'eq' | 'neq' | 'gt' | 'lt' | 'contains';

/** An already-validated condition predicate. */
export interface ConditionPredicate {
  readonly field: string;
  readonly op: AutomationConditionOp;
  readonly value: string;
}

/** A flat bag of fields the predicate reads by name, e.g. `{ project_id, status }`. */
export type ConditionEvent = Record<string, unknown>;

const OPS: readonly string[] = ['eq', 'neq', 'gt', 'lt', 'contains'];

/** Whether a stored token is one of the known operators (a stored row is never trusted blind). */
export function isAutomationConditionOp(value: string): value is AutomationConditionOp {
  return OPS.includes(value);
}

/**
 * Evaluate one condition against an event. Total: an absent field, or a non-numeric operand under
 * `gt`/`lt`, yields `false` rather than throwing, so a malformed event never fires a rule by accident.
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

/** The rule page's "any" chip value: `contains ''` holds for every event, field present or not. */
function isAnyValue(condition: { readonly op: string; readonly value: string }): boolean {
  return condition.op === 'contains' && condition.value === '';
}

/**
 * Whether a rule's saved conditions let it fire for `event`.
 *
 * `conditions` must be in creation order, oldest first (the stores read them `ORDER BY id`, and ids
 * are UUIDv7). The newest condition per field wins; every winning condition must hold. A stored row
 * with an unknown operator fails closed — the rule does not fire on a condition nobody can read.
 */
export function conditionsMatch(
  conditions: readonly { readonly field: string; readonly op: string; readonly value: string }[],
  event: ConditionEvent,
): boolean {
  const inForce = new Map<
    string,
    { readonly field: string; readonly op: string; readonly value: string }
  >();
  for (const condition of conditions) inForce.set(condition.field, condition);

  for (const condition of inForce.values()) {
    if (isAnyValue(condition)) continue;
    if (!isAutomationConditionOp(condition.op)) return false;
    if (
      !evaluateCondition(
        { field: condition.field, op: condition.op, value: condition.value },
        event,
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A stable string view of an event value. `null`/`undefined` compare as the empty string; objects
 * compare as empty, because a condition value is a scalar.
 */
function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}
