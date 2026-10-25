import { describe, expect, it } from 'vitest';
import { canSubmitDeliverableFeedback } from '../src/lib/api/portal-deliverable-feedback';

/**
 * Wave 9, lane S4 — audit run 1 F45: the deliverable feedback form is not offered to a read-only
 * client viewer (the API refuses them with 403), and is offered to the client roles that may act.
 */
describe('canSubmitDeliverableFeedback (F45)', () => {
  it('hides the form from a client viewer, an unknown role and a signed-out caller', () => {
    expect(canSubmitDeliverableFeedback('client_viewer')).toBe(false);
    expect(canSubmitDeliverableFeedback(undefined)).toBe(false);
    expect(canSubmitDeliverableFeedback('not-a-role')).toBe(false);
  });

  it('offers the form to client admin, reviewer and member', () => {
    for (const role of ['client_admin', 'client_reviewer', 'client_member']) {
      expect(canSubmitDeliverableFeedback(role)).toBe(true);
    }
  });

  it('never offers the client feedback form to internal staff', () => {
    expect(canSubmitDeliverableFeedback('owner')).toBe(false);
    expect(canSubmitDeliverableFeedback('manager')).toBe(false);
  });
});
