import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { PersonCertificationsController } from './certifications.controller.js';
import { validateCreate, toView } from './certifications.service.js';
import type {
  PersonCertificationsService,
  PersonCertificationView,
} from './certifications.service.js';
import type { PersonCertificationsRepository } from './certifications.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipRow, PersonCertificationRow } from '../../common/database/schema.js';

/**
 * Person certifications (x326) controller proofs, database-free over fakes with the *real*
 * `authorize`. The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here;
 * this file proves the controller's own logic: resolve-before-authorize (a cross-tenant person id is
 * 404 with no write), the deny for a role without `org.manage` (403 with no write), and the record →
 * list → delete path. `validateCreate` and `toView` (the 400s and the read-side expiry badge) are
 * proven directly, since they are pure.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PERSON = 'user-0000-0000-0000-0000-0000000000aa';
const ACTOR = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role']): Principal {
  return {
    userId: ACTOR,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: ACTOR } as unknown as TenantContext;

function membershipRow(userId: string, organizationId: string): MembershipRow {
  return { userId, organizationId } as unknown as MembershipRow;
}

const database = {
  read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

/** A controller over fakes. `createCalls`/`deleteCalls` record every mutation so a test can assert none. */
function controllerWith(members: readonly MembershipRow[]) {
  const store: PersonCertificationView[] = [];
  const createCalls: { personUserId: string; createdBy: string }[] = [];
  const deleteCalls: { personUserId: string; certificationId: string }[] = [];
  let seq = 0;

  const repository = {
    findPersonMembership: async (_runner: unknown, ctx: TenantContext, userId: string) =>
      members.find((m) => m.userId === userId && m.organizationId === ctx.organizationId) ?? null,
  } as unknown as PersonCertificationsRepository;

  const service = {
    list: async () => store.slice(),
    create: async (
      _db: unknown,
      _ctx: TenantContext,
      personUserId: string,
      createdBy: string,
      body: { name?: unknown; issuer?: unknown; issuedOn?: unknown; expiresOn?: unknown },
    ): Promise<PersonCertificationView> => {
      createCalls.push({ personUserId, createdBy });
      const view: PersonCertificationView = {
        id: `cert-${(seq += 1).toString().padStart(2, '0')}`,
        personUserId,
        name: String(body.name),
        issuer: String(body.issuer),
        issuedOn: String(body.issuedOn),
        expiresOn: body.expiresOn === undefined ? null : (body.expiresOn as string | null),
        expired: false,
        createdBy,
        createdAt: '2026-09-27T10:00:00.000Z',
      };
      store.push(view);
      return view;
    },
    delete: async (
      _db: unknown,
      _ctx: TenantContext,
      personUserId: string,
      certificationId: string,
    ): Promise<void> => {
      deleteCalls.push({ personUserId, certificationId });
      const index = store.findIndex((c) => c.id === certificationId);
      if (index !== -1) store.splice(index, 1);
    },
  } as unknown as PersonCertificationsService;

  return {
    controller: new PersonCertificationsController(database, service, repository),
    createCalls,
    deleteCalls,
  };
}

const localPerson = [membershipRow(PERSON, ORG)];

describe('PersonCertificationsController', () => {
  it('records a certification, lists it, and removes it', async () => {
    const { controller, deleteCalls } = controllerWith(localPerson);
    const actor = principal('owner');

    const added = await controller.create(context, actor, PERSON, {
      name: 'AWS Solutions Architect',
      issuer: 'Amazon Web Services',
      issuedOn: '2026-01-01',
      expiresOn: '2029-01-01',
    });
    expect(added.name).toBe('AWS Solutions Architect');
    expect(added.createdBy).toBe(ACTOR);
    expect(added).not.toHaveProperty('organizationId');

    const listed = await controller.list(context, actor, PERSON);
    expect(listed.certifications.map((c) => c.id)).toContain(added.id);

    await controller.remove(context, actor, PERSON, added.id);
    expect(deleteCalls).toHaveLength(1);
    const after = await controller.list(context, actor, PERSON);
    expect(after.certifications).toHaveLength(0);
  });

  it('returns 404 for a cross-tenant / unknown person id and writes nothing', async () => {
    // The person belongs to another org, so `findPersonMembership` resolves null in this tenant.
    const { controller, createCalls } = controllerWith([]);

    await expect(
      controller.create(context, principal('owner'), PERSON, {
        name: 'PMP',
        issuer: 'PMI',
        issuedOn: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.create(context, principal('owner'), PERSON, {
        name: 'PMP',
        issuer: 'PMI',
        issuedOn: '2026-01-01',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(createCalls).toEqual([]);
  });

  it('refuses to record a certification without org.manage (403) and writes nothing', async () => {
    const { controller, createCalls } = controllerWith(localPerson);
    // `member` holds work.read but not org.manage (capabilities ceiling), so the org-scoped authorize
    // denies the write with a 403 — after the person resolves, before any insert.
    await expect(
      controller.create(context, principal('member'), PERSON, {
        name: 'PMP',
        issuer: 'PMI',
        issuedOn: '2026-01-01',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(createCalls).toEqual([]);
  });

  it('refuses a delete for a cross-tenant person id with 404 and writes nothing', async () => {
    const { controller, deleteCalls } = controllerWith([]);
    await expect(
      controller.remove(context, principal('owner'), PERSON, 'cert-01'),
    ).rejects.toMatchObject({ status: 404 });
    expect(deleteCalls).toEqual([]);
  });
});

describe('validateCreate', () => {
  it('rejects an empty name or issuer with 400', () => {
    expect(() =>
      validateCreate({ name: '   ', issuer: 'PMI', issuedOn: '2026-01-01' }),
    ).toThrowError(ApiError);
    expect(() => validateCreate({ name: 'PMP', issuer: '', issuedOn: '2026-01-01' })).toThrowError(
      ApiError,
    );
  });

  it('rejects a missing or malformed issued date with 400', () => {
    expect(() => validateCreate({ name: 'PMP', issuer: 'PMI' })).toThrowError(ApiError);
    expect(() => validateCreate({ name: 'PMP', issuer: 'PMI', issuedOn: '01/2026' })).toThrowError(
      ApiError,
    );
  });

  it('rejects an expiry before the issue date with 400', () => {
    expect(() =>
      validateCreate({
        name: 'PMP',
        issuer: 'PMI',
        issuedOn: '2026-06-01',
        expiresOn: '2026-01-01',
      }),
    ).toThrowError(ApiError);
  });

  it('accepts a valid credential, treating absent/empty expiry as no expiry', () => {
    expect(validateCreate({ name: '  PMP  ', issuer: 'PMI', issuedOn: '2026-01-01' })).toEqual({
      name: 'PMP',
      issuer: 'PMI',
      issuedOn: '2026-01-01',
      expiresOn: null,
    });
    expect(
      validateCreate({ name: 'PMP', issuer: 'PMI', issuedOn: '2026-01-01', expiresOn: '' }),
    ).toMatchObject({ expiresOn: null });
  });
});

describe('toView', () => {
  const base: PersonCertificationRow = {
    id: 'cert-01',
    organizationId: ORG,
    personUserId: PERSON,
    name: 'PMP',
    issuer: 'PMI',
    issuedOn: '2020-01-01',
    expiresOn: null,
    createdBy: ACTOR,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
  } as unknown as PersonCertificationRow;

  it('marks a credential expired when its expiry is before today, never when unset', () => {
    expect(toView(base, '2026-09-27').expired).toBe(false);
    expect(toView({ ...base, expiresOn: '2026-09-26' }, '2026-09-27').expired).toBe(true);
    expect(toView({ ...base, expiresOn: '2026-09-27' }, '2026-09-27').expired).toBe(false);
    expect(toView({ ...base, expiresOn: '2027-01-01' }, '2026-09-27').expired).toBe(false);
  });

  it('never echoes organizationId', () => {
    expect(toView(base, '2026-09-27')).not.toHaveProperty('organizationId');
  });
});
