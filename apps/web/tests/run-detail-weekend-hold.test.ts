import { describe, expect, it } from 'vitest';
import { describeRunDetail } from '../src/components/screens/run-detail-view';

/**
 * Gap 10 — a weekend-held run and the Sunday run that delivers it read as sentences; the ids the
 * delivery needs never reach the screen.
 */
describe('run detail for weekend-held runs', () => {
  it('explains the hold and hides what the Sunday delivery reads', () => {
    const lines = describeRunDetail({
      templateId: 't',
      triggerKind: 'work_item_created',
      outcome: 'not_run',
      reason: 'held_for_weekend',
      heldEventId: '019a-event',
      heldObjectType: 'work_item',
      heldObjectId: '019a-item',
      heldProjectId: '019a-project',
    });
    expect(lines.map((l) => l.label)).toEqual(['Trigger', 'Outcome', 'Why']);
    expect(lines[2]!.value).toBe('Held for the weekend. It is sent on Sunday morning instead.');
    expect(JSON.stringify(lines)).not.toMatch(/019a/);
  });

  it('hides the held run a delivery closes', () => {
    const lines = describeRunDetail({
      outcome: 'executed',
      effect: 'Notified the owner in their inbox on Sunday morning, after the weekend.',
      heldRunId: '019a-run',
    });
    expect(lines.map((l) => l.label)).toEqual(['Outcome', 'What it did']);
  });
});
