/**
 * 58-C1 — the branching automation rule ("When > If > Yes/No > Then"), as pure data and pure
 * decisions shared by the API (save, manual test run) and the worker (rules firing on their
 * trigger).
 *
 * A flow is a small graph of nodes. An **action** node names one action kind and the node that
 * follows it; a **condition** node reads one `(field, op, value)` predicate and points at the
 * first node of its Yes and No branches. A linear rule is the branch-less graph: one action node.
 *
 * Saving checks two different things:
 *
 * - **Shape** ({@link parseAutomationFlow}): a malformed graph is refused outright — unknown node
 *   or action kinds, unknown fields or operators, bad or duplicate ids, a reference to no node, a
 *   cycle, a node reached twice or never, conditions nested deeper than allowed, or a graph over
 *   the size bound.
 * - **Completeness** ({@link flowIssues}): a well-shaped draft may still have a step with no
 *   action chosen or a branch with no step. A draft like that is saved, but never turned on or run.
 *
 * No I/O and no clock: the same flow and event always give the same path.
 */

import { conditionsMatch } from './automation-conditions.js';
import type { ConditionEvent } from './automation-conditions.js';

/** The bounds a saved flow must keep. */
export const AUTOMATION_FLOW_LIMITS = {
  /** Nodes in one flow. */
  maxNodes: 40,
  /** Conditions on one path. The approved design has one If; nested conditions are not asked for. */
  maxConditionDepth: 1,
  /** `value` length, the `workflow_conditions.value` column bound. */
  maxValueLength: 500,
} as const;

/**
 * The action kinds a Then may name — the API's `WORKFLOW_ACTION_KINDS` allowlist. Naming a kind is
 * not running it: the runners decide which kinds have an executor.
 */
export const AUTOMATION_ACTION_KINDS = [
  'notify_owner',
  'create_work_item',
  'post_message',
  'send_email_digest',
] as const;

/** The event fields an If may read — the ones the runner supplies (`conditionEventFor`). */
export const AUTOMATION_FLOW_FIELDS = ['status', 'project_id', 'object_type'] as const;
export type AutomationFlowField = (typeof AUTOMATION_FLOW_FIELDS)[number];

const OPS: readonly string[] = ['eq', 'neq', 'gt', 'lt', 'contains'];
const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export interface AutomationFlowActionNode {
  readonly id: string;
  readonly type: 'action';
  /** `null` while the step is unfinished ("Choose what happens"). */
  readonly actionKind: string | null;
  readonly next: string | null;
}

export interface AutomationFlowConditionNode {
  readonly id: string;
  readonly type: 'condition';
  readonly field: AutomationFlowField;
  readonly op: 'eq' | 'neq' | 'gt' | 'lt' | 'contains';
  readonly value: string;
  /** First step of the Yes branch; `null` while the branch is empty. */
  readonly yes: string | null;
  /** First step of the No branch; `null` while the branch is empty. */
  readonly no: string | null;
}

export type AutomationFlowNode = AutomationFlowActionNode | AutomationFlowConditionNode;

export interface AutomationFlow {
  /** The first step after the trigger; `null` for a flow with no steps yet. */
  readonly start: string | null;
  readonly nodes: readonly AutomationFlowNode[];
}

/** Why a flow's shape was refused. */
export type AutomationFlowShapeError =
  | 'not_an_object'
  | 'too_many_nodes'
  | 'bad_node'
  | 'bad_node_id'
  | 'duplicate_node_id'
  | 'unknown_action_kind'
  | 'unknown_field'
  | 'unknown_op'
  | 'value_too_long'
  | 'dangling_reference'
  | 'cycle'
  | 'shared_node'
  | 'unreachable_node'
  | 'too_deep';

export type ParseAutomationFlowResult =
  | { readonly ok: true; readonly flow: AutomationFlow }
  | {
      readonly ok: false;
      readonly error: AutomationFlowShapeError;
      readonly nodeId: string | null;
    };

/** One reason a well-shaped flow is not ready to turn on. */
export type AutomationFlowIssue =
  | { readonly reason: 'flow_empty'; readonly nodeId: null; readonly branch: null }
  | { readonly reason: 'action_missing'; readonly nodeId: string; readonly branch: null }
  | { readonly reason: 'branch_empty'; readonly nodeId: string; readonly branch: 'yes' | 'no' };

/** One step the runner took, in order — the per-step run log. */
export type AutomationFlowStep =
  | { readonly nodeId: string; readonly type: 'condition'; readonly branch: 'yes' | 'no' }
  | { readonly nodeId: string; readonly type: 'action'; readonly actionKind: string };

/** The branch-less graph of a linear rule: its one action. */
export function linearAutomationFlow(actionKind: string): AutomationFlow {
  return { start: 'step-1', nodes: [{ id: 'step-1', type: 'action', actionKind, next: null }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

type NodeParse =
  { readonly node: AutomationFlowNode } | { readonly error: AutomationFlowShapeError };

function parseNode(raw: unknown): NodeParse {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return { error: 'bad_node' };
  const id = raw['id'];
  if (!NODE_ID.test(id)) return { error: 'bad_node_id' };
  if (raw['type'] === 'action') {
    const actionKind = refOrNull(raw['actionKind']);
    const next = refOrNull(raw['next']);
    if (actionKind === undefined || next === undefined) return { error: 'bad_node' };
    if (
      actionKind !== null &&
      !(AUTOMATION_ACTION_KINDS as readonly string[]).includes(actionKind)
    ) {
      return { error: 'unknown_action_kind' };
    }
    return { node: { id, type: 'action', actionKind, next } };
  }
  if (raw['type'] === 'condition') {
    const { field, op, value } = raw;
    const yes = refOrNull(raw['yes']);
    const no = refOrNull(raw['no']);
    if (typeof field !== 'string' || typeof op !== 'string' || typeof value !== 'string') {
      return { error: 'bad_node' };
    }
    if (yes === undefined || no === undefined) return { error: 'bad_node' };
    if (!(AUTOMATION_FLOW_FIELDS as readonly string[]).includes(field)) {
      return { error: 'unknown_field' };
    }
    if (!OPS.includes(op)) return { error: 'unknown_op' };
    if (value.length > AUTOMATION_FLOW_LIMITS.maxValueLength) return { error: 'value_too_long' };
    return {
      node: {
        id,
        type: 'condition',
        field: field as AutomationFlowField,
        op: op as AutomationFlowConditionNode['op'],
        value,
        yes,
        no,
      },
    };
  }
  return { error: 'bad_node' };
}

function successors(node: AutomationFlowNode): readonly string[] {
  const refs = node.type === 'action' ? [node.next] : [node.yes, node.no];
  return refs.filter((ref): ref is string => ref !== null);
}

/**
 * Check a flow's shape. Total: any input gives a result, never a
 * throw, so a request body or a stored row can be passed straight in.
 */
export function parseAutomationFlow(input: unknown): ParseAutomationFlowResult {
  if (!isRecord(input) || !Array.isArray(input['nodes'])) {
    return { ok: false, error: 'not_an_object', nodeId: null };
  }
  const start = refOrNull(input['start']);
  if (start === undefined) return { ok: false, error: 'not_an_object', nodeId: null };
  const rawNodes: readonly unknown[] = input['nodes'];
  if (rawNodes.length > AUTOMATION_FLOW_LIMITS.maxNodes) {
    return { ok: false, error: 'too_many_nodes', nodeId: null };
  }

  const byId = new Map<string, AutomationFlowNode>();
  for (const raw of rawNodes) {
    const parsed = parseNode(raw);
    if ('error' in parsed) return { ok: false, error: parsed.error, nodeId: null };
    if (byId.has(parsed.node.id)) {
      return { ok: false, error: 'duplicate_node_id', nodeId: parsed.node.id };
    }
    byId.set(parsed.node.id, parsed.node);
  }

  const refs = [...(start === null ? [] : [start]), ...[...byId.values()].flatMap(successors)];
  const dangling = refs.find((ref) => !byId.has(ref));
  if (dangling !== undefined) return { ok: false, error: 'dangling_reference', nodeId: dangling };

  // Walk from the start: a node met again on the current path is a cycle, met again elsewhere is
  // a merge (the builder draws a tree, so a step belongs to exactly one place).
  const visited = new Set<string>();
  const onPath = new Set<string>();
  const walk = (id: string, depth: number): ParseAutomationFlowResult | null => {
    if (onPath.has(id)) return { ok: false, error: 'cycle', nodeId: id };
    if (visited.has(id)) return { ok: false, error: 'shared_node', nodeId: id };
    const node = byId.get(id);
    if (node === undefined) return { ok: false, error: 'dangling_reference', nodeId: id };
    const nextDepth = node.type === 'condition' ? depth + 1 : depth;
    if (nextDepth > AUTOMATION_FLOW_LIMITS.maxConditionDepth) {
      return { ok: false, error: 'too_deep', nodeId: id };
    }
    visited.add(id);
    onPath.add(id);
    for (const child of successors(node)) {
      const failure = walk(child, nextDepth);
      if (failure !== null) return failure;
    }
    onPath.delete(id);
    return null;
  };
  if (start !== null) {
    const failure = walk(start, 0);
    if (failure !== null) return failure;
  }
  const unreachable = [...byId.keys()].find((id) => !visited.has(id));
  if (unreachable !== undefined) {
    // A node outside the walk is either orphaned or part of a loop nobody enters.
    const inLoop = (() => {
      const seen = new Set<string>();
      let current: string | undefined = unreachable;
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const node = byId.get(current);
        current = node === undefined ? undefined : successors(node)[0];
      }
      return current === unreachable;
    })();
    return { ok: false, error: inLoop ? 'cycle' : 'unreachable_node', nodeId: unreachable };
  }

  return { ok: true, flow: { start, nodes: [...byId.values()] } };
}

/** What still stops a well-shaped flow from being turned on; empty when it is complete. */
export function flowIssues(flow: AutomationFlow): readonly AutomationFlowIssue[] {
  if (flow.start === null) return [{ reason: 'flow_empty', nodeId: null, branch: null }];
  const issues: AutomationFlowIssue[] = [];
  for (const node of flow.nodes) {
    if (node.type === 'action') {
      if (node.actionKind === null) {
        issues.push({ reason: 'action_missing', nodeId: node.id, branch: null });
      }
      continue;
    }
    if (node.yes === null) issues.push({ reason: 'branch_empty', nodeId: node.id, branch: 'yes' });
    if (node.no === null) issues.push({ reason: 'branch_empty', nodeId: node.id, branch: 'no' });
  }
  return issues;
}

/**
 * The path one event takes through a complete flow: each If with the branch it chose, each Then
 * with its action, in order. An If holds exactly as an "Only if" condition does (`conditionsMatch`:
 * `contains ''` is "any", an absent field or unknown operator does not hold). An unfinished step
 * ends the path — a caller runs only complete flows.
 */
export function planAutomationFlow(
  flow: AutomationFlow,
  event: ConditionEvent,
): readonly AutomationFlowStep[] {
  const byId = new Map(flow.nodes.map((node) => [node.id, node] as const));
  const steps: AutomationFlowStep[] = [];
  let current = flow.start;
  while (current !== null && steps.length < AUTOMATION_FLOW_LIMITS.maxNodes) {
    const node = byId.get(current);
    if (node === undefined) break;
    if (node.type === 'condition') {
      const holds = conditionsMatch([node], event);
      steps.push({ nodeId: node.id, type: 'condition', branch: holds ? 'yes' : 'no' });
      current = holds ? node.yes : node.no;
      continue;
    }
    if (node.actionKind === null) break;
    steps.push({ nodeId: node.id, type: 'action', actionKind: node.actionKind });
    current = node.next;
  }
  return steps;
}
