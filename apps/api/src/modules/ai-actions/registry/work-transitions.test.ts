import { describe, expect, it } from 'vitest';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import { workDetails } from './work.js';

/**
 * 2026-11-23: three MCP calls from a new user failed with 400 validation_failed because the
 * tool told the AI that `version` and `to` were optional free text, while the endpoint requires
 * both and accepts only the machine's states. The tool input must ask for what the server needs.
 */
function detail(id: string) {
  const d = workDetails.find((x) => x.id === id);
  if (!d) throw new Error(`missing detail ${id}`);
  return d;
}

describe('work item transition tools ask for what the endpoint requires', () => {
  const single = detail('work_items.transitions.create');
  const bulk = detail('work_items.bulk_transition.create');

  it('requires version and a known state on a single move', () => {
    expect(single.input.safeParse({ workItemId: 'wi_1', to: 'done' }).success).toBe(false);
    expect(single.input.safeParse({ workItemId: 'wi_1', version: 2, to: 'finished' }).success).toBe(
      false,
    );
    for (const to of WORK_ITEM_STATES) {
      expect(single.input.safeParse({ workItemId: 'wi_1', version: 2, to }).success, to).toBe(true);
    }
  });

  it('requires ids and a known state on a bulk move', () => {
    expect(bulk.input.safeParse({}).success).toBe(false);
    expect(bulk.input.safeParse({ ids: [], targetStatus: 'ready' }).success).toBe(false);
    expect(bulk.input.safeParse({ ids: ['wi_1'], targetStatus: 'Done' }).success).toBe(false);
    expect(bulk.input.safeParse({ ids: ['wi_1'], targetStatus: 'ready' }).success).toBe(true);
  });

  it('gives examples that parse', () => {
    for (const d of [single, bulk]) {
      expect(d.examples.length, d.id).toBeGreaterThan(0);
      for (const e of d.examples) expect(d.input.safeParse(e.args).success, e.summary).toBe(true);
    }
  });
});
