import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetOrganizations,
  rememberOrganizations,
  wasKnownOrganization,
} from '../src/components/shell/known-memberships';
import { authBoundary } from '../src/lib/auth-boundary';

// B16: a slug this browser never saw (`/admin`) is "not found", not "you no longer have access".
describe('known-memberships (B16)', () => {
  beforeEach(() => forgetOrganizations());

  it('knows only slugs seen in an earlier list, and forgets them at a change of principal', () => {
    expect(wasKnownOrganization('admin')).toBe(false);
    rememberOrganizations(['northstar']);
    expect(wasKnownOrganization('northstar')).toBe(true);
    expect(wasKnownOrganization('admin')).toBe(false);
    authBoundary.announce('signed-out');
    expect(wasKnownOrganization('northstar')).toBe(false);
  });
});
