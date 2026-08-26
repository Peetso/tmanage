import { describe, expect, it } from 'vitest';
import {
  checkInvites,
  describeInviteProblem,
  domainOf,
  isPlausibleEmail,
} from '../src/lib/invitations';

const DOMAIN = 'northstar.studio';

describe('isPlausibleEmail', () => {
  it.each([
    'omar@northstar.studio',
    'omar.adel+tag@northstar.studio',
    'o@a.co',
    'first.last@sub.domain.example',
  ])('accepts %s', (email) => {
    expect(isPlausibleEmail(email)).toBe(true);
  });

  it.each(['', '   ', 'omar', 'omar@', '@northstar.studio', 'omar@studio', 'omar @a.co', 'a@b.'])(
    'rejects %o',
    (email) => {
      expect(isPlausibleEmail(email)).toBe(false);
    },
  );

  /**
   * The `@` in a display name is why the domain is taken from the *last* `@`, and this is the
   * case that would break a naive `split('@')[1]`.
   */
  it('takes the domain from the last @', () => {
    expect(domainOf('weird@name@northstar.studio')).toBe('northstar.studio');
  });
});

describe('checkInvites', () => {
  function check(emails: readonly string[], existingMembers: readonly string[] = []) {
    return checkInvites({
      candidates: emails.map((email) => ({ email, role: 'member' })),
      organizationDomain: DOMAIN,
      existingMembers,
    });
  }

  it('accepts a colleague', () => {
    const [invite] = check(['maya@northstar.studio']);
    expect(invite?.problems).toEqual([]);
    expect(invite?.sendable).toBe(true);
  });

  it('marks an address outside the organization domain as a client, not an error', () => {
    const [invite] = check(['salma@atlashospitality.com']);
    expect(invite?.problems).toEqual(['outside-domain']);
    expect(describeInviteProblem('outside-domain', DOMAIN)).toContain('client organization');
  });

  it('marks the second occurrence of a duplicate, never the first', () => {
    const results = check(['maya@northstar.studio', 'maya@northstar.studio']);
    expect(results[0]?.problems).toEqual([]);
    expect(results[1]?.problems).toEqual(['duplicate-in-list']);
  });

  it('treats a duplicate case-insensitively', () => {
    const results = check(['Maya@Northstar.Studio', 'maya@northstar.studio']);
    expect(results[1]?.problems).toEqual(['duplicate-in-list']);
  });

  it('recognises an existing member regardless of case or surrounding space', () => {
    const [invite] = check(['  KARIM@northstar.studio '], ['karim@northstar.studio']);
    expect(invite?.problems).toEqual(['already-a-member']);
  });

  it('reports several problems on one address', () => {
    const [, second] = check(
      ['salma@atlashospitality.com', 'salma@atlashospitality.com'],
      ['salma@atlashospitality.com'],
    );
    expect(second?.problems).toEqual(['duplicate-in-list', 'already-a-member', 'outside-domain']);
    expect(second?.sendable).toBe(false);
  });

  it('does not also call a malformed address a duplicate or a foreigner', () => {
    const [invite] = check(['not-an-address']);
    expect(invite?.problems).toEqual(['malformed']);
  });

  it('trims the address it reports back, so the screen shows what will be sent', () => {
    const [invite] = check(['  maya@northstar.studio  ']);
    expect(invite?.email).toBe('maya@northstar.studio');
  });

  it('preserves input order and length', () => {
    const results = check(['a@northstar.studio', 'bad', 'b@northstar.studio']);
    expect(results).toHaveLength(3);
    expect(results.map((invite) => invite.email)).toEqual([
      'a@northstar.studio',
      'bad',
      'b@northstar.studio',
    ]);
  });

  it('checks no domain when the organization has not got one yet', () => {
    const results = checkInvites({
      candidates: [{ email: 'anyone@anywhere.example', role: 'member' }],
      organizationDomain: '',
      existingMembers: [],
    });
    expect(results[0]?.problems).toEqual([]);
  });
});

describe('describeInviteProblem', () => {
  it('names the organization domain so the sentence is actionable', () => {
    expect(describeInviteProblem('outside-domain', DOMAIN)).toContain(DOMAIN);
  });

  it('says no second invitation will be sent to an existing member', () => {
    expect(describeInviteProblem('already-a-member', DOMAIN)).toContain('No second invitation');
  });
});
