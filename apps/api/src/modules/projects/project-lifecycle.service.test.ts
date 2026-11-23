import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectVersionConflictError, type ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

/**
 * Fix lane C (2026-11-23, G1, closes PRJ-4): a project can be renamed, archived, restored and —
 * when it holds nothing — deleted. The object check runs on the loaded row (I-4: a project the
 * caller cannot read is 404); the audit row shares the unit of work (DA-11); a project that still
 * holds anything is 409 `project_not_empty`.
 */

const context = { organizationId: 'org-1', userId: 'u-1' } as TenantContext;
const base = {
  organizationId: 'org-1',
  kind: 'internal',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
} as const;
const owner: Principal = {
  ...base,
  userId: 'u-1',
  role: 'owner',
  projectIds: [],
  hasOrgWideScope: true,
};
const member: Principal = {
  ...base,
  userId: 'u-2',
  role: 'member',
  projectIds: ['p-1'],
  hasOrgWideScope: false,
};
const outsider: Principal = {
  ...base,
  userId: 'u-3',
  role: 'member',
  projectIds: [],
  hasOrgWideScope: false,
};
const at = new Date('2026-11-23T09:00:00.000Z');
const row = (over: Partial<ProjectRow> = {}): ProjectRow =>
  ({
    id: 'p-1',
    organizationId: 'org-1',
    workspaceId: 'ws-1',
    name: 'Atlas',
    status: 'active',
    ownerUserId: 'u-1',
    committedAt: null,
    forecastAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...over,
  }) as ProjectRow;

function build(repo: Partial<Record<keyof ProjectsRepository, unknown>>) {
  const tx = { tx: true };
  const database = {
    transaction: async (_c: unknown, fn: (runner: unknown) => unknown) => fn(tx),
  } as unknown as TenantDatabase;
  const record = vi.fn(async () => undefined);
  const service = new ProjectsService(
    database,
    repo as unknown as ProjectsRepository,
    { record } as unknown as AuditService,
  );
  return { service, record, tx };
}

describe('fix lane C · project rename', () => {
  it('renames with the version last read and audits project.renamed', async () => {
    const update = vi.fn(async () => row({ name: 'Atlas 2' }));
    const { service, record, tx } = build({ findById: async () => row(), update });
    const view = await service.rename(context, owner, 'p-1', {
      name: 'Atlas 2',
      expectedUpdatedAt: at.toISOString(),
    });
    expect(view.name).toBe('Atlas 2');
    expect(update).toHaveBeenCalledWith(tx, context, 'p-1', at, { name: 'Atlas 2' });
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'project.renamed', objectId: 'p-1' }),
    );
  });

  it('answers a stale version with 409 and writes no audit row', async () => {
    const { service, record } = build({
      findById: async () => row(),
      update: async () => {
        throw new ProjectVersionConflictError('p-1', 1);
      },
    });
    await expect(
      service.rename(context, owner, 'p-1', {
        name: 'X',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a member without project.manage (403) and hides an unrelated project (404)', async () => {
    const { service } = build({ findById: async () => row() });
    const input = { name: 'X', expectedUpdatedAt: at.toISOString() };
    await expect(service.rename(context, member, 'p-1', input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.rename(context, outsider, 'p-1', input)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('fix lane C · project archive and restore', () => {
  it('archives an active project and restores an archived one, each audited', async () => {
    const archive = vi.fn(async () => row({ archivedAt: at }));
    const unarchive = vi.fn(async () => row());
    const active = build({ findById: async () => row(), archive, unarchive });
    const archivedView = await active.service.setArchived(context, owner, 'p-1', true);
    expect(archivedView.archivedAt).toBe(at.toISOString());
    expect(active.record).toHaveBeenCalledWith(
      active.tx,
      context,
      expect.objectContaining({ action: 'project.archived' }),
    );

    const archived = build({ findById: async () => row({ archivedAt: at }), archive, unarchive });
    const restored = await archived.service.setArchived(context, owner, 'p-1', false);
    expect(restored.archivedAt).toBe(null);
    expect(archived.record).toHaveBeenCalledWith(
      archived.tx,
      context,
      expect.objectContaining({ action: 'project.unarchived' }),
    );
  });

  it('archiving an archived project writes nothing', async () => {
    const archive = vi.fn();
    const { service, record } = build({ findById: async () => row({ archivedAt: at }), archive });
    await service.setArchived(context, owner, 'p-1', true);
    expect(archive).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('fix lane C · delete an empty project', () => {
  it('deletes an empty project with its audit row, in one unit of work', async () => {
    const deleteEmpty = vi.fn(async () => undefined);
    const { service, record, tx } = build({ findById: async () => row(), deleteEmpty });
    await service.deleteEmpty(context, owner, 'p-1');
    expect(deleteEmpty).toHaveBeenCalledWith(tx, context, 'p-1');
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'project.deleted', objectId: 'p-1' }),
    );
  });

  it('answers a project that still holds anything (MariaDB 1451) with 409 project_not_empty', async () => {
    const referenced = Object.assign(new Error('Cannot delete or update a parent row'), {
      errno: 1451,
    });
    const { service } = build({
      findById: async () => row(),
      deleteEmpty: async () => {
        throw new Error('wrapped', { cause: referenced });
      },
    });
    await expect(service.deleteEmpty(context, owner, 'p-1')).rejects.toMatchObject({
      status: 409,
      details: [{ field: 'projectId', message: 'project_not_empty' }],
    });
  });

  it('needs project.delete: a member is 403, an unrelated project 404, nothing deleted', async () => {
    const deleteEmpty = vi.fn();
    const { service } = build({ findById: async () => row(), deleteEmpty });
    await expect(service.deleteEmpty(context, member, 'p-1')).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.deleteEmpty(context, outsider, 'p-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(deleteEmpty).not.toHaveBeenCalled();
  });
});
