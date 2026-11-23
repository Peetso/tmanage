import { describe, expect, it } from 'vitest';
import { isPhotoRemovedHere, mayListProfilePhoto, maySeeProfilePhoto } from './profile-photo.js';

const internal = { kind: 'internal', role: 'member', clientOrganizationId: null } as const;
const acme = { kind: 'client', role: 'client_viewer', clientOrganizationId: 'acme' } as const;

describe('maySeeProfilePhoto', () => {
  it('members are seen by everyone in the company', () => {
    const staff = { internalMember: true, clientOrganizationIds: [] };
    expect(maySeeProfilePhoto(internal, staff)).toBe(true);
    expect(maySeeProfilePhoto(acme, staff)).toBe(true);
  });

  it("a client sees their own client's contacts, never another client's", () => {
    expect(
      maySeeProfilePhoto(acme, { internalMember: false, clientOrganizationIds: ['acme'] }),
    ).toBe(true);
    expect(
      maySeeProfilePhoto(acme, { internalMember: false, clientOrganizationIds: ['globex'] }),
    ).toBe(false);
    expect(
      maySeeProfilePhoto(internal, { internalMember: false, clientOrganizationIds: ['globex'] }),
    ).toBe(true);
  });

  it('nobody sees a person who does not belong to the company', () => {
    expect(maySeeProfilePhoto(internal, { internalMember: false, clientOrganizationIds: [] })).toBe(
      false,
    );
  });

  it('the list never hands a client the staff roster', () => {
    const staff = { internalMember: true, clientOrganizationIds: [] };
    expect(mayListProfilePhoto(acme, staff)).toBe(false);
    expect(mayListProfilePhoto(internal, staff)).toBe(true);
    expect(
      mayListProfilePhoto(acme, { internalMember: false, clientOrganizationIds: ['acme'] }),
    ).toBe(true);
  });

  it('a removal hides only the same photo', () => {
    expect(isPhotoRemovedHere('a', 'a')).toBe(true);
    expect(isPhotoRemovedHere('b', 'a')).toBe(false);
    expect(isPhotoRemovedHere('a', null)).toBe(false);
  });
});
