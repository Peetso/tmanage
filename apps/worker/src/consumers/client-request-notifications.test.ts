import { describe, expect, it } from 'vitest';
import { INTERNAL_ROLES, hasCapability } from '@tmanage/domain';
import { mayTriageClientRequests } from './client-request-notifications.js';

/**
 * The pure half of the submitted-request recipient rule. What the consumers do to real
 * rows — the dedupe under redelivery, the revocation silences, the withdrawn exception —
 * is proved against a real server in `apps/api/test/notif-001-notifications.db.test.ts`.
 */

describe('mayTriageClientRequests', () => {
  it('agrees with the domain ceiling for every internal role, org-wide', () => {
    // Not a restatement: the expectation itself is computed from `capabilitiesFor`, so a
    // matrix change moves both sides and this asserts the *wiring*, not the table.
    for (const role of INTERNAL_ROLES) {
      const expected = hasCapability(role, 'client_request.triage');
      expect(
        mayTriageClientRequests({ userId: 'u', role, hasOrgWideScope: true, onProject: false }),
        role,
      ).toBe(expected);
    }
  });

  it('requires a relation: no org-wide scope and no project membership means no', () => {
    expect(
      mayTriageClientRequests({
        userId: 'u',
        role: 'manager',
        hasOrgWideScope: false,
        onProject: false,
      }),
    ).toBe(false);
    expect(
      mayTriageClientRequests({
        userId: 'u',
        role: 'manager',
        hasOrgWideScope: false,
        onProject: true,
      }),
    ).toBe(true);
  });

  it('refuses a role the domain does not know', () => {
    expect(
      mayTriageClientRequests({
        userId: 'u',
        role: 'superuser',
        hasOrgWideScope: true,
        onProject: true,
      }),
    ).toBe(false);
  });
});
