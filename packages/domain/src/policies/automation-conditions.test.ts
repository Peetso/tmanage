import { describe, expect, it } from 'vitest';
import { conditionsMatch, evaluateCondition } from './automation-conditions.js';

describe('conditionsMatch (C1 — a rule fires only when its saved conditions match)', () => {
  const event = { project_id: 'p1', status: 'in_progress' };

  it('fires when there are no conditions', () => {
    expect(conditionsMatch([], event)).toBe(true);
  });

  it('fires when every condition matches', () => {
    expect(
      conditionsMatch(
        [
          { field: 'project_id', op: 'eq', value: 'p1' },
          { field: 'status', op: 'neq', value: 'done' },
        ],
        event,
      ),
    ).toBe(true);
  });

  it('does not fire when one condition does not match', () => {
    expect(
      conditionsMatch(
        [
          { field: 'project_id', op: 'eq', value: 'p1' },
          { field: 'status', op: 'eq', value: 'done' },
        ],
        event,
      ),
    ).toBe(false);
  });

  it('uses the newest condition per field, and treats contains "" as any', () => {
    // The rule page appends: project p2 first, then "any project".
    expect(
      conditionsMatch(
        [
          { field: 'project_id', op: 'eq', value: 'p2' },
          { field: 'project_id', op: 'contains', value: '' },
        ],
        event,
      ),
    ).toBe(true);
    expect(conditionsMatch([{ field: 'status', op: 'contains', value: '' }], {})).toBe(true);
  });

  it('fails closed on an unknown stored operator or an absent field', () => {
    expect(conditionsMatch([{ field: 'status', op: 'regex', value: '.*' }], event)).toBe(false);
    expect(conditionsMatch([{ field: 'priority', op: 'eq', value: 'high' }], event)).toBe(false);
  });

  it('keeps evaluateCondition total', () => {
    expect(evaluateCondition({ field: 'score', op: 'gt', value: 'x' }, { score: 3 })).toBe(false);
  });
});
