import { describe, expect, it } from 'vitest';
import { defaultOrgWideScope } from './principal.repository.js';
import { policyVersionOf } from './membership-resolver.repository.js';

/**
 * The two pure decisions behind TEN-001's scope and policy-version leftovers (0023), tested
 * without a server. The wiring into the real columns is proven by the tenancy DB suites; these
 * fix the decisions themselves so a refactor cannot quietly change them.
 */

describe('defaultOrgWideScope', () => {
  it('grants org-wide default scope to owner and org_admin only', () => {
    expect(defaultOrgWideScope('owner')).toBe(true);
    expect(defaultOrgWideScope('org_admin')).toBe(true);
    // A Workspace Admin must NOT get org-wide scope by role name — that is the leak 0023's
    // workspace_scope_id exists to avoid. Ordinary members never had it.
    expect(defaultOrgWideScope('workspace_admin')).toBe(false);
    expect(defaultOrgWideScope('member')).toBe(false);
  });
});

describe('policyVersionOf', () => {
  it('is the v2 epoch of the two stored policy versions, not of updated_at', () => {
    expect(policyVersionOf(1, 1)).toBe('v2:1:1');
    // Same organization epoch, a bumped membership epoch (a role/scope change) → a new key.
    expect(policyVersionOf(1, 2)).not.toBe(policyVersionOf(1, 1));
    // Same membership epoch, a bumped organization epoch (an org-policy change) → a new key.
    expect(policyVersionOf(2, 1)).not.toBe(policyVersionOf(1, 1));
    // Unchanged inputs → the same key, so an unrelated rename that never moves either column
    // cannot rotate the epoch.
    expect(policyVersionOf(3, 5)).toBe(policyVersionOf(3, 5));
  });
});
