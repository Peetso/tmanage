import type {
  AutomationFlow,
  AutomationFlowActionNode,
  AutomationFlowConditionNode,
} from '@tmanage/domain';

/**
 * 58-C1 — the builder's editing model. A saved flow (one If at most, the bound the API enforces)
 * reads as lanes: the main path of Then steps, then optionally one If with a Yes lane and a No lane.
 * Every edit is made on lanes and turned back into a linked flow, so the builder never has to
 * re-link nodes by hand. Pure: no I/O, no React.
 */

export type LaneName = 'trunk' | 'yes' | 'no';

export type FlowCondition = Pick<AutomationFlowConditionNode, 'id' | 'field' | 'op' | 'value'>;

export interface FlowLanes {
  readonly trunk: readonly AutomationFlowActionNode[];
  readonly condition: FlowCondition | null;
  readonly yes: readonly AutomationFlowActionNode[];
  readonly no: readonly AutomationFlowActionNode[];
}

function chain(
  byId: ReadonlyMap<string, AutomationFlow['nodes'][number]>,
  start: string | null,
): {
  readonly actions: AutomationFlowActionNode[];
  readonly end: AutomationFlowConditionNode | null;
} {
  const actions: AutomationFlowActionNode[] = [];
  let current = start;
  while (current !== null) {
    const node = byId.get(current);
    if (node === undefined) break;
    if (node.type === 'condition') return { actions, end: node };
    actions.push(node);
    current = node.next;
  }
  return { actions, end: null };
}

/** Read a flow as lanes. */
export function toLanes(flow: AutomationFlow): FlowLanes {
  const byId = new Map(flow.nodes.map((node) => [node.id, node] as const));
  const trunk = chain(byId, flow.start);
  const condition = trunk.end;
  if (condition === null) return { trunk: trunk.actions, condition: null, yes: [], no: [] };
  const { id, field, op, value } = condition;
  return {
    trunk: trunk.actions,
    condition: { id, field, op, value },
    yes: chain(byId, condition.yes).actions,
    no: chain(byId, condition.no).actions,
  };
}

function linked(
  actions: readonly AutomationFlowActionNode[],
  after: string | null,
): AutomationFlowActionNode[] {
  return actions.map((node, index) => ({ ...node, next: actions[index + 1]?.id ?? after }));
}

/** Turn lanes back into a linked flow. */
export function fromLanes(lanes: FlowLanes): AutomationFlow {
  const trunk = linked(lanes.trunk, lanes.condition?.id ?? null);
  const nodes: AutomationFlow['nodes'][number][] = [...trunk];
  if (lanes.condition !== null) {
    nodes.push({
      ...lanes.condition,
      type: 'condition',
      yes: lanes.yes[0]?.id ?? null,
      no: lanes.no[0]?.id ?? null,
    });
    nodes.push(...linked(lanes.yes, null), ...linked(lanes.no, null));
  }
  return { start: nodes[0]?.id ?? null, nodes };
}

/** A fresh node id the flow does not use yet (`s1`, `s2`, …). */
export function nextNodeId(flow: AutomationFlow): string {
  const used = new Set(flow.nodes.map((node) => node.id));
  let n = flow.nodes.length + 1;
  while (used.has(`s${String(n)}`)) n += 1;
  return `s${String(n)}`;
}

/** Insert an unfinished Then at `index` of a lane. */
export function insertStep(
  flow: AutomationFlow,
  lane: LaneName,
  index: number,
): { readonly flow: AutomationFlow; readonly nodeId: string } {
  const lanes = toLanes(flow);
  const nodeId = nextNodeId(flow);
  const step: AutomationFlowActionNode = {
    id: nodeId,
    type: 'action',
    actionKind: null,
    next: null,
  };
  const list = [...lanes[lane]];
  list.splice(index, 0, step);
  return { flow: fromLanes({ ...lanes, [lane]: list }), nodeId };
}

/**
 * Insert the If at `index` of the main path: the steps after it become its Yes branch and the No
 * branch starts empty. A flow already has at most one If.
 */
export function insertCondition(
  flow: AutomationFlow,
  index: number,
): { readonly flow: AutomationFlow; readonly nodeId: string } {
  const lanes = toLanes(flow);
  const nodeId = nextNodeId(flow);
  return {
    flow: fromLanes({
      trunk: lanes.trunk.slice(0, index),
      condition: { id: nodeId, field: 'status', op: 'eq', value: 'done' },
      yes: lanes.trunk.slice(index),
      no: [],
    }),
    nodeId,
  };
}

/** Choose the action of one Then. */
export function setAction(
  flow: AutomationFlow,
  nodeId: string,
  actionKind: string,
): AutomationFlow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === nodeId && node.type === 'action' ? { ...node, actionKind } : node,
    ),
  };
}

/** Change what the If checks. */
export function setCondition(
  flow: AutomationFlow,
  check: Pick<AutomationFlowConditionNode, 'field' | 'op' | 'value'>,
): AutomationFlow {
  const lanes = toLanes(flow);
  return lanes.condition === null
    ? flow
    : fromLanes({ ...lanes, condition: { ...lanes.condition, ...check } });
}

/** Remove one step. Removing the If keeps its Yes steps on the main path and drops the No steps. */
export function removeStep(flow: AutomationFlow, nodeId: string): AutomationFlow {
  const lanes = toLanes(flow);
  if (lanes.condition?.id === nodeId) {
    return fromLanes({ trunk: [...lanes.trunk, ...lanes.yes], condition: null, yes: [], no: [] });
  }
  const without = (list: readonly AutomationFlowActionNode[]) =>
    list.filter((node) => node.id !== nodeId);
  return fromLanes({
    ...lanes,
    trunk: without(lanes.trunk),
    yes: without(lanes.yes),
    no: without(lanes.no),
  });
}

/** Where a step sits: its lane and 1-based position, or `null` for the If itself or an unknown id. */
export function locateStep(
  lanes: FlowLanes,
  nodeId: string,
): { readonly lane: LaneName; readonly position: number } | null {
  for (const lane of ['trunk', 'yes', 'no'] as const) {
    const index = lanes[lane].findIndex((node) => node.id === nodeId);
    if (index >= 0) return { lane, position: index + 1 };
  }
  return null;
}

/**
 * Whether an edit is saved straight away. A rule that is off saves every draft; a rule that is on
 * may only hold a finished graph (the API refuses anything else), so its draft waits until done.
 */
export function savesNow(enabled: boolean, issueCount: number): boolean {
  return !enabled || issueCount === 0;
}
