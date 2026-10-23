import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PORTAL_ACCESS_RESOURCE_KINDS } from '../../common/database/schema.js';
import type { ProjectRow, ProjectUpdateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectUpdatesController, readMilestoneId } from './project-updates.controller.js';
import { PortalService, firstOpenSince, toManagedUpdateView } from './portal.service.js';

/**
 * A10 — the internal updates list behind the published-update card and the unpublish dialog:
 * the "already opened" read from the portal access log, the projection, the route ceiling, the
 * 404-first project resolve and the `milestoneId` body check. No DB in this suite.
 */

const ORG = 'org-under-test';
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;

function internalManager(): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function updateRow(published: boolean): ProjectUpdateRow {
  return {
    id: 'upd-1',
    organizationId: ORG,
    projectId: 'proj-1',
    title: 'Week 3 update',
    body: 'Homepage and menu designs are ready.',
    milestoneId: 'ms-1',
    published,
    createdByUserId: 'user-1',
    createdAt: new Date('2026-10-21T09:00:00.000Z'),
    updatedAt: new Date('2026-10-21T09:00:00.000Z'),
  } as ProjectUpdateRow;
}

const opens = [
  { accessedAt: new Date('2026-10-23T08:00:00.000Z'), clientName: 'Atlas Hospitality' },
  { accessedAt: new Date('2026-10-22T10:00:00.000Z'), clientName: 'Atlas Hospitality' },
  { accessedAt: new Date('2026-10-20T10:00:00.000Z'), clientName: 'Earlier Co' },
];

describe('A10 published update card + unpublish confirm (API)', () => {
  it('records portal update reads under the update access-log kind', () => {
    expect(PORTAL_ACCESS_RESOURCE_KINDS).toContain('update');
  });

  it('reports the earliest client open at or after the update was posted', () => {
    expect(firstOpenSince(opens, new Date('2026-10-21T09:00:00.000Z'))).toEqual({
      clientName: 'Atlas Hospitality',
      openedAt: '2026-10-22T10:00:00.000Z',
    });
    expect(firstOpenSince(opens, new Date('2026-10-24T00:00:00.000Z'))).toBeNull();
  });

  it('projects author and milestone, and no client open for a draft', () => {
    const milestone = { id: 'ms-1', title: 'Design sign-off', dueOn: '2026-11-14' };
    const published = toManagedUpdateView(
      { update: updateRow(true), authorName: 'Karim Adel', milestone },
      opens,
    );
    expect(published.authorName).toBe('Karim Adel');
    expect(published.milestone).toEqual(milestone);
    expect(published.clientOpened?.clientName).toBe('Atlas Hospitality');

    const draft = toManagedUpdateView(
      { update: updateRow(false), authorName: 'Karim Adel', milestone: null },
      opens,
    );
    expect(draft.clientOpened).toBeNull();
    expect(draft.milestone).toBeNull();
  });

  it('guards the internal list with project.manage', () => {
    const handler = (ProjectUpdatesController.prototype as unknown as Record<string, object>)[
      'list'
    ] as object;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('project.manage');
  });

  it('answers 404 for a project outside the tenant before reading any update', async () => {
    const projects = {
      findById: () => Promise.resolve(null as ProjectRow | null),
    } as unknown as ProjectsRepository;
    const service = new PortalService(fakeDatabase(), projects);
    await expect(
      service.managedUpdatesFor(context, internalManager(), 'proj-elsewhere'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('accepts an absent, null or string milestoneId and refuses anything else', () => {
    const details: { field: string; message: string }[] = [];
    expect(readMilestoneId(undefined, details)).toBeUndefined();
    expect(readMilestoneId(null, details)).toBeNull();
    expect(readMilestoneId('ms-1', details)).toBe('ms-1');
    expect(details).toHaveLength(0);
    readMilestoneId(42, details);
    expect(details[0]?.field).toBe('milestoneId');
  });
});
