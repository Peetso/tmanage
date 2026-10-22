import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ClientsService } from './clients.service.js';
import type { ClientOrganizationsRepository } from './client-organizations.repository.js';
import type { ClientMembershipsRepository } from './client-memberships.repository.js';
import type { ProjectClientsRepository } from './project-clients.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * BK1 (ADM-02, PRJ-02) — the client picker and "set a project's client", over fakes with the
 * real `authorize()`. The live round-trip is left to the chain's db/e2e.
 */

const ORG = 'org-1';
const PROJECT = 'project-1';
const context = { organizationId: ORG, userId: 'u-1' } as unknown as TenantContext;

function principal(role: 'manager' | 'client_viewer'): Principal {
  return {
    userId: 'u-1',
    organizationId: ORG,
    kind: role === 'manager' ? 'internal' : 'client',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: role === 'manager' ? null : 'co-a',
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  } as Principal;
}

const now = new Date('2026-10-22T00:00:00Z');
const orgRow = (id: string, name: string) => ({ id, name, archivedAt: null, createdAt: now });

function build(initialShares: string[]) {
  let shares = initialShares.map((c, i) => ({
    id: `pc-${i}`,
    projectId: PROJECT,
    clientOrganizationId: c,
    createdAt: now,
  }));
  const run = <T>(_c: TenantContext, work: (r: never) => Promise<T>) => work({} as never);
  const database = { read: run, transaction: run } as unknown as TenantDatabase;
  const organizations = {
    list: () => Promise.resolve([orgRow('co-b', 'Zeta'), orgRow('co-a', 'Acme')]),
    findById: (_r: never, _c: TenantContext, id: string) => Promise.resolve(orgRow(id, id)),
  } as unknown as ClientOrganizationsRepository;
  const projectClients = {
    list: () => Promise.resolve(shares),
    unshare: (_r: never, _c: TenantContext, i: { clientOrganizationId: string }) => {
      shares = shares.filter((s) => s.clientOrganizationId !== i.clientOrganizationId);
      return Promise.resolve(true);
    },
    share: (_r: never, _c: TenantContext, i: { clientOrganizationId: string }) => {
      const row = { id: 'pc-new', projectId: PROJECT, ...i, createdAt: now };
      shares = [...shares, row];
      return Promise.resolve(row);
    },
  } as unknown as ProjectClientsRepository;
  const projects = {
    findById: () => Promise.resolve({ id: PROJECT, archivedAt: null }),
  } as unknown as ProjectsRepository;
  const service = new ClientsService(
    database,
    { defaultExpiryDays: 90 },
    organizations,
    {} as ClientMembershipsRepository,
    projectClients,
    projects,
  );
  return { service, current: () => shares.map((s) => s.clientOrganizationId) };
}

describe('ClientsService — BK1 client picker and project client', () => {
  it('lists picker options as id and name, sorted by name, and refuses a client principal', async () => {
    const { service } = build([]);
    await expect(service.listOrganizationOptions(context, principal('manager'))).resolves.toEqual([
      { id: 'co-a', name: 'Acme' },
      { id: 'co-b', name: 'Zeta' },
    ]);
    await expect(
      service.listOrganizationOptions(context, principal('client_viewer')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('replaces the existing client with the new one, and null clears it', async () => {
    const { service, current } = build(['co-a']);
    const set = await service.setProjectClient(context, principal('manager'), PROJECT, 'co-b');
    expect(set.map((v) => v.clientOrganizationId)).toEqual(['co-b']);
    expect(current()).toEqual(['co-b']);

    await expect(
      service.setProjectClient(context, principal('manager'), PROJECT, null),
    ).resolves.toEqual([]);
    expect(current()).toEqual([]);
  });
});
