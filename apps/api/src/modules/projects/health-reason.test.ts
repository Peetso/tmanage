import { describe, expect, it } from 'vitest';
import { healthReasonOf, type ProjectHealthSignals } from './health.service.js';

/** D7 — the client page's Risks line says why a project is red or amber, from the score's own weights. */

const none: ProjectHealthSignals = {
  overdueMilestones: 0,
  openRisks: 0,
  highRisks: 0,
  objectivesTotal: 0,
  objectivesMet: 0,
  objectivesMissed: 0,
};

describe('healthReasonOf (D7)', () => {
  it('names the signal that cost the most score', () => {
    // 2 overdue milestones (30) outweigh 1 high risk (20).
    expect(healthReasonOf({ ...none, overdueMilestones: 2, openRisks: 1, highRisks: 1 })).toEqual({
      kind: 'overdueMilestones',
      count: 2,
    });
    // 3 other open risks (24) outweigh 1 missed objective (12); high risks are not counted twice.
    expect(
      healthReasonOf({
        ...none,
        openRisks: 4,
        highRisks: 1,
        objectivesMissed: 1,
        objectivesTotal: 2,
      }),
    ).toEqual({ kind: 'openRisks', count: 3 });
  });

  it('a tie goes to the earlier signal, and a project that lost nothing has no reason', () => {
    // 4 × 15 = 60 = 3 × 20.
    expect(healthReasonOf({ ...none, overdueMilestones: 4, openRisks: 3, highRisks: 3 })).toEqual({
      kind: 'overdueMilestones',
      count: 4,
    });
    expect(healthReasonOf(none)).toBeNull();
  });
});
