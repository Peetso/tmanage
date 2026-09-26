import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalPeopleController } from './portal-people.controller.js';
import type { PortalPersonView } from './portal-people.projection.js';
import type { PortalPeopleProjection } from './portal-people.projection.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';

/**
 * Portal people — the client-visible team of a project — over fakes with **real** `authorize()`.
 *
 * The fakes stand in only for the database, the projects read and the people projection.
 * `authorize()` is the real policy, so these cases prove the actual security decisions x142 exists
 * for: the view carries name and role and nothing else, a member outside the named project is
 * never listed, a cross-tenant or unknown `projectId` is a 404, and a client reading a project
 * outside their own scope is a 404 — never a 403 that would confirm the project is real. The live
 * round-trip is deferred to the chain's db/e2e (no DB test / no new e2e in this slice).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const PROJECT = 'project-visible';

/** A client viewer whose single shared project is `readableProjectId`. */
function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;

/** A fake database whose `read` runs the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

/** A projects repo that resolves exactly the ids it was told exist (tenant-scoped `findById`). */
function fakeProjects(existing: readonly string[]): ProjectsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ProjectRow) : null),
  } as unknown as ProjectsRepository;
}

/** A people projection: returns the members it was seeded with for the named project only. */
function fakePeople(byProject: Record<string, readonly PortalPersonView[]>): PortalPeopleProjection {
  return {
    listForProject: (_r: never, _c: TenantContext, projectId: string) =>
      Promise.resolve(byProject[projectId] ?? []),
  } as unknown as PortalPeopleProjection;
}

function controllerWith(
  existingProjects: readonly string[],
  byProject: Record<string, readonly PortalPersonView[]>,
): PortalPeopleController {
  return new PortalPeopleController(
    fakeDatabase(),
    fakeProjects(existingProjects),
    fakePeople(byProject),
  );
}

describe('PortalPeopleController.people_ (x142)', () => {
  it('returns name and role only, and never a member outside the named project', async () => {
    const controller = controllerWith([PROJECT], {
      [PROJECT]: [
        { displayName: 'Ada Lovelace', role: 'lead' },
        { displayName: 'Bo Nguyen', role: 'member' },
      ],
      'project-other': [{ displayName: 'Someone Else', role: 'member' }],
    });

    const { people } = await controller.people_(context, clientPrincipal(PROJECT), PROJECT);

    expect(people).toEqual([
      { displayName: 'Ada Lovelace', role: 'lead' },
      { displayName: 'Bo Nguyen', role: 'member' },
    ]);
    // The view carries no staff PII and no internal identifier (§4 excludes staff).
    for (const person of people) {
      expect(Object.keys(person).sort()).toEqual(['displayName', 'role']);
      expect(person).not.toHaveProperty('email');
      expect(person).not.toHaveProperty('userId');
      expect(person).not.toHaveProperty('membershipId');
    }
  });

  it('answers 404 for an unknown or cross-tenant projectId (resolved before the read)', async () => {
    // The named project does not resolve in this tenant → not-found, no people read.
    const controller = controllerWith([PROJECT], { [PROJECT]: [] });

    await expect(
      controller.people_(context, clientPrincipal(PROJECT), 'project-elsewhere'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 when a client reads a project outside their own scope', async () => {
    // The project resolves in the tenant, but it is not shared with this client → authorize denies
    // → 404, not 403 (a 403 would confirm the project exists).
    const controller = controllerWith([PROJECT, 'project-not-shared'], {
      'project-not-shared': [{ displayName: 'Internal Only', role: 'member' }],
    });

    await expect(
      controller.people_(context, clientPrincipal(PROJECT), 'project-not-shared'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
