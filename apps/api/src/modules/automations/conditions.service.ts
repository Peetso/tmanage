/**
 * Automations & integrations (module 17, x190). The pure, deterministic evaluator behind a workflow
 * condition.
 *
 * C1 moved the evaluator into `@tmanage/domain` (`policies/automation-conditions.ts`) so the API and
 * the worker — where a rule fires on its trigger — read a rule's conditions the same way. This module
 * re-exports it under its original name so existing callers keep their import.
 *
 * `evaluateCondition` decides one `(field, op, value)` predicate against an event; `conditionsMatch`
 * decides a whole rule: the newest condition per field is the one in force, `contains ''` is the
 * rule page's "any", and a rule with no conditions always fires.
 */
export { conditionsMatch, evaluateCondition } from '@tmanage/domain';
export type { ConditionEvent, ConditionPredicate } from '@tmanage/domain';
