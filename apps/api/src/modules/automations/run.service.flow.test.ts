import { describe, expect, it } from 'vitest';
import { linearAutomationFlow } from '@tmanage/domain';
import { WorkflowRunService } from './run.service.js';

describe('58-C1 WorkflowRunService.executeFlow', () => {
  const service = new WorkflowRunService();

  it('runs a linear rule as its one-step graph and logs the step', () => {
    const outcome = service.executeFlow(
      'tpl',
      'work_item_created',
      1,
      linearAutomationFlow('notify_owner'),
      {},
    );
    expect(outcome).toMatchObject({ status: 'succeeded', notifiesRunner: true });
    expect(outcome.detail['steps']).toEqual([
      { nodeId: 'step-1', type: 'action', actionKind: 'notify_owner', outcome: 'executed' },
    ]);
  });

  it('does not run an unfinished graph', () => {
    const draft = {
      start: 'step-1',
      nodes: [{ id: 'step-1', type: 'action' as const, actionKind: null, next: null }],
    };
    expect(service.executeFlow('tpl', 'work_item_created', 2, draft, {})).toMatchObject({
      status: 'failed',
      notifiesRunner: false,
      detail: { reason: 'flow_incomplete', flowVersion: 2 },
    });
  });
});
