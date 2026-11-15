import { describe, expect, it } from 'vitest';
import {
  flowIssues,
  linearAutomationFlow,
  parseAutomationFlow,
  planAutomationFlow,
} from './automation-flow.js';

const branching = {
  start: 'if',
  nodes: [
    { id: 'if', type: 'condition', field: 'status', op: 'eq', value: 'done', yes: 'y', no: 'n' },
    { id: 'y', type: 'action', actionKind: 'notify_owner', next: null },
    { id: 'n', type: 'action', actionKind: 'post_message', next: null },
  ],
};

describe('58-C1 automation flow', () => {
  it('flags an incomplete branch and refuses a cycle or unknown action', () => {
    const draft = parseAutomationFlow({
      ...branching,
      nodes: [{ ...branching.nodes[0], no: null }, branching.nodes[1]],
    });
    expect(draft.ok && flowIssues(draft.flow)).toEqual([
      { reason: 'branch_empty', nodeId: 'if', branch: 'no' },
    ]);
    const loop = {
      start: 'a',
      nodes: [
        { id: 'a', type: 'action', actionKind: 'notify_owner', next: 'b' },
        { id: 'b', type: 'action', actionKind: 'notify_owner', next: 'a' },
      ],
    };
    expect(parseAutomationFlow(loop)).toMatchObject({ ok: false, error: 'cycle' });
    expect(parseAutomationFlow(linearAutomationFlow('send_bitcoin'))).toMatchObject({
      ok: false,
      error: 'unknown_action_kind',
    });
  });

  it('takes the Yes or the No branch by the event', () => {
    const parsed = parseAutomationFlow(branching);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(planAutomationFlow(parsed.flow, { status: 'done' }).at(-1)).toEqual({
      nodeId: 'y',
      type: 'action',
      actionKind: 'notify_owner',
    });
    expect(planAutomationFlow(parsed.flow, { status: 'open' }).map((s) => s.nodeId)).toEqual([
      'if',
      'n',
    ]);
  });
});
