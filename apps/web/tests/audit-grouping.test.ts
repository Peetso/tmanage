import { describe, expect, it } from 'vitest';
import { groupDeniedRuns } from '../src/components/screens/AdminAuditScreen';
import type { AdminAuditEvent } from '../src/lib/api/admin-audit';

/** ADM-11: consecutive refusals collapse into one line; everything else stays a single row. */
function event(id: string, result: AdminAuditEvent['result']): AdminAuditEvent {
  return {
    id,
    occurredAt: '2026-02-01T09:00:00.000Z',
    actorId: 'user-a',
    action: 'security.capability_denied',
    entityType: 'capability',
    entityId: null,
    result,
    summary: 'Blocked for a missing permission',
  };
}

describe('groupDeniedRuns', () => {
  it('collapses a run of two or more consecutive refusals into one item', () => {
    const items = groupDeniedRuns([
      event('1', 'allowed'),
      event('2', 'denied'),
      event('3', 'denied'),
      event('4', 'denied'),
      event('5', 'allowed'),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['single', 'refused-run', 'single']);
    const run = items[1];
    expect(run?.kind === 'refused-run' && run.events.length).toBe(3);
    expect(run?.kind === 'refused-run' && run.key).toBe('refused-2');
  });

  it('leaves a lone refusal as its own row rather than a run', () => {
    const items = groupDeniedRuns([event('1', 'denied'), event('2', 'allowed')]);
    expect(items.map((item) => item.kind)).toEqual(['single', 'single']);
  });

  it('does not group an errored event with refusals', () => {
    const items = groupDeniedRuns([
      event('1', 'denied'),
      event('2', 'error'),
      event('3', 'denied'),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['single', 'single', 'single']);
  });
});
