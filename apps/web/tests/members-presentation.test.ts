import { describe, expect, it } from 'vitest';
import { formerMemberLabel, memberDisplayName, memberLabel } from '../src/lib/members-presentation';
import type { MemberSummary } from '../src/lib/api/members';

/**
 * ADM-07 (CQ-05) — an offboarded member whose name is still known reads as "Former member: Name",
 * never a bare name that would suggest they are still on the team, and never a raw id.
 */

const ADA: MemberSummary = {
  userId: 'u-ada',
  displayName: 'Ada Okonkwo',
  role: 'member',
  status: 'active',
};
const OMAR_GONE: MemberSummary = {
  userId: 'u-omar',
  displayName: 'Omar Haddad',
  role: 'manager',
  status: 'offboarded',
};

describe('members-presentation (ADM-07)', () => {
  it('reads an offboarded member as a former member, by name', () => {
    expect(formerMemberLabel('Omar Haddad')).toBe('Former member: Omar Haddad');
    expect(memberDisplayName('u-omar', [OMAR_GONE])).toBe('Former member: Omar Haddad');
  });

  it('leaves an active member as their plain name', () => {
    expect(memberDisplayName('u-ada', [ADA])).toBe('Ada Okonkwo');
  });

  it('marks an offboarded member in a picker option, keeping the role for disambiguation', () => {
    expect(memberLabel(OMAR_GONE)).toBe('Former member: Omar Haddad · Manager');
    expect(memberLabel(ADA)).toBe('Ada Okonkwo · Team member');
  });
});
