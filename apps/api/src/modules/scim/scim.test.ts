import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  ScimError,
  hashScimKey,
  likePrefix,
  newScimKey,
  parseGroupPatch,
  parseScimFilter,
  parseUserPatch,
  readScimBearer,
  SCHEMA_PATCH,
} from './scim-protocol.js';
import { ScimService, type ScimCaller, type ScimServiceDeps } from './scim.service.js';

/**
 * 54-16 / 56-10c — SCIM provisioning and its hardening proofs: wrong, revoked and SSO-less keys
 * answer 401; filters are allow-listed and decoded as data; an id of another organization is not
 * found; the company owner cannot be deactivated; an account's address cannot be rewritten.
 */

const ORG = '0190f0a0-0000-7000-8000-000000000001';
const CORR = '0190f0a0-0000-7000-8000-0000000000c1';
const CALLER: ScimCaller = { organizationId: ORG, keyId: 'key-1', correlationId: CORR };
const OWNER = { kind: 'internal', role: 'owner', userId: 'u-owner' } as unknown as Principal;
const MEMBER = { kind: 'internal', role: 'admin', userId: 'u-admin' } as unknown as Principal;
const CONTEXT = { organizationId: ORG } as never;

function member(overrides: Record<string, unknown> = {}) {
  return {
    membershipId: 'm-1',
    email: 'rana@northstar.example',
    displayName: 'Rana',
    status: 'active',
    role: 'member',
    userId: 'u-1',
    emailVerifiedAt: new Date(),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function service(overrides: Record<string, unknown> = {}) {
  const run = async (_o: unknown, work: (r: unknown) => unknown) => work({});
  const repository = {
    findKeyByHash: vi.fn(async () => null),
    hasSsoConnection: vi.fn(async () => true),
    touchKey: vi.fn(async () => undefined),
    findUser: vi.fn(async () => null),
    findUsers: vi.fn(async () => []),
    toUserRecords: vi.fn(async (_r: unknown, _c: unknown, rows: { membershipId: string }[]) =>
      rows.map((row) => ({ ...row, groups: [] })),
    ),
    groupMembers: vi.fn(async () => []),
    listLiveKeys: vi.fn(async () => []),
    insertKey: vi.fn(async () => undefined),
    ...((overrides['repository'] as object) ?? {}),
  };
  const memberships = {
    requireById: vi.fn(async () => ({ id: 'm-1', role: 'owner', version: 1 })),
    transitionStatus: vi.fn(),
    findByUserId: vi.fn(async () => null),
    invite: vi.fn(),
  };
  const deps = {
    database: {
      read: run,
      transaction: run,
      bootstrapRead: run,
      identityRead: run,
      identityTransaction: run,
    },
    webPublicUrl: 'https://app.example',
    connections: { find: vi.fn(async () => ({ allowedDomains: 'northstar.example' })) },
    teams: {
      findTeamById: vi.fn(async () => ({ id: 't-1', name: 'Design', createdAt: new Date(0) })),
    },
    memberships,
    ...overrides,
    repository,
  } as unknown as ScimServiceDeps;
  return { scim: new ScimService(deps), repository, memberships };
}

describe('56-10c SCIM keys: wrong, revoked, other organization', () => {
  it('answers 401 for a missing, malformed, unknown or revoked key', async () => {
    const { scim, repository } = service();
    for (const header of [
      undefined,
      'Basic abc',
      'Bearer tmanage_pat_x',
      `Bearer ${'x'.repeat(56)}`,
    ]) {
      await expect(scim.authenticate(header, CORR)).rejects.toMatchObject({ status: 401 });
    }
    const { secret } = newScimKey();
    await expect(scim.authenticate(`Bearer ${secret}`, CORR)).rejects.toMatchObject({
      status: 401,
    });
    repository.findKeyByHash.mockResolvedValueOnce({
      id: 'key-1',
      organizationId: ORG,
      tokenHash: hashScimKey(secret),
      revokedAt: new Date(),
    } as never);
    await expect(scim.authenticate(`Bearer ${secret}`, CORR)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('accepts a live key only for its own organization, and stops when SSO is removed', async () => {
    const { secret } = newScimKey();
    const row = {
      id: 'key-1',
      organizationId: ORG,
      tokenHash: hashScimKey(secret),
      revokedAt: null,
    };
    const { scim, repository } = service({
      repository: {
        findKeyByHash: vi.fn(async (_db: unknown, hash: string) =>
          hash === row.tokenHash ? row : null,
        ),
      },
    });
    await expect(scim.authenticate(`Bearer ${secret}`, CORR)).resolves.toMatchObject({
      organizationId: ORG,
    });
    repository.hasSsoConnection.mockResolvedValueOnce(false);
    await expect(scim.authenticate(`Bearer ${secret}`, CORR)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('lets only the owner create a key, and only with company sign-in', async () => {
    const { scim } = service({ connections: { find: vi.fn(async () => null) } });
    await expect(scim.createKey(CONTEXT, MEMBER, { name: 'Okta' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(scim.createKey(CONTEXT, OWNER, { name: 'Okta' })).rejects.toMatchObject({
      status: 409,
    });
    const ok = service();
    const created = await ok.scim.createKey(CONTEXT, OWNER, { name: 'Okta' });
    expect(created.secret).toMatch(/^tmanage_scim_/u);
    expect(ok.repository.insertKey).toHaveBeenCalledWith(
      expect.anything(),
      CONTEXT,
      expect.objectContaining({ tokenHash: hashScimKey(created.secret) }),
    );
  });
});

describe('56-10c SCIM filters: injection', () => {
  it('decodes the value as data and refuses anything but one allow-listed comparison', () => {
    expect(parseScimFilter('userName eq "Rana@Northstar.example"', 'User')).toEqual({
      field: 'email',
      op: 'eq',
      value: 'rana@northstar.example',
    });
    expect(parseScimFilter('userName eq "a\\" or 1=1 --"', 'User')?.value).toBe('a" or 1=1 --');
    for (const bad of [
      'userName eq "a" or userName pr',
      'password eq "x"',
      'userName co "a"',
      'userName eq a',
      'userName eq "a"; DROP TABLE users',
      `userName eq "${'a'.repeat(600)}"`,
    ]) {
      expect(() => parseScimFilter(bad, 'User')).toThrow(ScimError);
    }
    expect(likePrefix('a%_\\')).toBe('a\\%\\_\\\\%');
    expect(readScimBearer('Bearer x y')).toBeUndefined();
  });
});

describe('56-10c SCIM resources: cross-tenant, owner, address', () => {
  it('answers 404 for a user id of another organization', async () => {
    const { scim } = service();
    await expect(scim.getUser(CALLER, 'm-of-other-org')).rejects.toMatchObject({ status: 404 });
    await expect(scim.deleteUser(CALLER, 'm-of-other-org')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a group member that is not a user of this organization', async () => {
    const { scim } = service();
    const body = {
      schemas: [SCHEMA_PATCH],
      Operations: [{ op: 'add', path: 'members', value: [{ value: 'm-x' }] }],
    };
    await expect(scim.patchGroup(CALLER, 't-1', body)).rejects.toMatchObject({
      status: 400,
      scimType: 'invalidValue',
    });
  });

  it('never deactivates the company owner', async () => {
    const { scim, memberships } = service({
      repository: { findUser: vi.fn(async () => member({ role: 'owner' })) },
    });
    await expect(scim.deleteUser(CALLER, 'm-1')).rejects.toMatchObject({
      status: 400,
      scimType: 'mutability',
    });
    const body = {
      schemas: [SCHEMA_PATCH],
      Operations: [{ op: 'replace', value: { active: 'False' } }],
    };
    await expect(scim.patchUser(CALLER, 'm-1', body)).rejects.toMatchObject({
      scimType: 'mutability',
    });
    expect(memberships.transitionStatus).not.toHaveBeenCalled();
  });

  it('refuses deactivating a member who became the owner after the read (checked in the transaction)', async () => {
    // The listing said `member`, but by the time of the write the row is the owner: the re-read
    // inside the transaction refuses it, so SCIM can never leave a company without its owner.
    const { scim, memberships } = service({
      repository: { findUser: vi.fn(async () => member()) },
    });
    memberships.requireById.mockResolvedValue({ id: 'm-1', role: 'owner', version: 2 });
    await expect(scim.deleteUser(CALLER, 'm-1')).rejects.toMatchObject({ scimType: 'mutability' });
    expect(memberships.transitionStatus).not.toHaveBeenCalled();
  });

  it('suspends a member on active false and refuses a change of address', async () => {
    const { scim, memberships } = service({
      repository: { findUser: vi.fn(async () => member()) },
    });
    memberships.requireById.mockResolvedValue({ id: 'm-1', role: 'member', version: 3 });
    await scim.patchUser(CALLER, 'm-1', {
      schemas: [SCHEMA_PATCH],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(memberships.transitionStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'm-1',
      3,
      'suspended',
    );
    await expect(
      scim.patchUser(CALLER, 'm-1', {
        schemas: [SCHEMA_PATCH],
        Operations: [{ op: 'replace', path: 'userName', value: 'ceo@northstar.example' }],
      }),
    ).rejects.toMatchObject({ scimType: 'mutability' });
  });

  it('refuses to provision an address outside the company sign-in domains', async () => {
    const { scim } = service();
    await expect(scim.createUser(CALLER, { userName: 'someone@gmail.com' })).rejects.toMatchObject({
      status: 400,
      scimType: 'invalidValue',
    });
  });
});

describe('54-16 SCIM PATCH parsing', () => {
  it('reads provider-style operations', () => {
    expect(
      parseUserPatch({
        schemas: [SCHEMA_PATCH],
        Operations: [{ op: 'Replace', value: { active: true, 'name.givenName': 'Rana' } }],
      }),
    ).toEqual({ active: true, displayName: 'Rana' });
    expect(
      parseGroupPatch({
        schemas: [SCHEMA_PATCH],
        Operations: [
          { op: 'remove', path: 'members[value eq "m-2"]' },
          { op: 'add', path: 'members', value: [{ value: 'm-3' }] },
          { op: 'replace', path: 'displayName', value: 'Studio' },
        ],
      }),
    ).toEqual({ displayName: 'Studio', addMembers: ['m-3'], removeMembers: ['m-2'] });
    expect(() => parseUserPatch({ Operations: [] })).toThrow(ScimError);
  });
});
