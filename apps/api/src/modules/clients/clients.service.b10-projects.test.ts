import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ClientsService } from './clients.service.js';
import type { ClientOrganizationsRepository } from './client-organizations.repository.js';
import type { ClientMembershipsRepository } from './client-memberships.repository.js';
import type { ProjectClientsRepository } from './project-clients.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** B10 — the projects shared with one client company, over fakes with the real `authorize()`. */

const ORG = 'org-1';
const context = { organizationId: ORG, userId: 'u-1' } as unknown as TenantContext;
const AT = new Date('2026-10-01T00:00:00.000Z');

function principal(kind: 'internal' | 'client'): Principal {
  return {
    userId: 'u-1',
    organizationId: ORG,
    kind,
    role: kind === 'internal' ? 'owner' : 'client_admin',
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'internal' ? null : 'co-a',
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  } as unknown as Principal;
}

function build() {
  const asked: unknown[] = [];
  const run = <T>(_c: TenantContext, work: (r: never) => Promise<T>) => work({} as never);
  const database = { read: run, transaction: run } as unknown as TenantDatabase;
  const organizations = {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(id === 'co-a' ? { id, name: 'Acme', archivedAt: null } : null),
  } as unknown as ClientOrganizationsRepository;
  const shares = {
    list: (_r: never, _c: TenantContext, options: unknown) => {
      asked.push(options);
      return Promise.resolve(
        ['p-z', 'p-old', 'p-a'].map((projectId) => ({ projectId, createdAt: AT })),
      );
    },
  } as unknown as ProjectClientsRepository;
  const rows: Record<string, { name: string; archivedAt: Date | null }> = {
    'p-z': { name: 'Zeta site', archivedAt: null },
    'p-old': { name: 'Old brochure', archivedAt: AT },
    'p-a': { name: 'Atlas launch', archivedAt: null },
  };
  const projects = {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve({ id, status: 'active', ...rows[id]! }),
  } as unknown as ProjectsRepository;
  const service = new ClientsService(
    database,
    { defaultExpiryDays: 90 },
    organizations,
    {} as ClientMembershipsRepository,
    shares,
    projects,
  );
  return { service, asked };
}

describe('ClientsService.listOrganizationProjects (B10)', () => {
  it("lists the company's active shared projects by name and keeps them to staff", async () => {
    const { service, asked } = build();
    await expect(
      service.listOrganizationProjects(context, principal('internal'), 'co-a'),
    ).resolves.toEqual([
      { id: 'p-a', name: 'Atlas launch', status: 'active', sharedAt: AT.toISOString() },
      { id: 'p-z', name: 'Zeta site', status: 'active', sharedAt: AT.toISOString() },
    ]);
    expect(asked).toEqual([{ clientOrganizationId: 'co-a', limit: 200 }]);

    await expect(
      service.listOrganizationProjects(context, principal('internal'), 'co-foreign'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.listOrganizationProjects(context, principal('client'), 'co-a'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
