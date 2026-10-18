import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { ProjectMembershipsRepository } from './project-memberships.repository.js';
import { ProjectsService } from './projects.service.js';

const context = { organizationId: 'org-1', userId: 'u-creator' } as TenantContext;
const tx = { tx: true };
const at = new Date('2026-10-18T00:00:00.000Z');

describe('PRJ-01 ProjectsService.create', () => {
  it('puts the creator on the new project as its manager, in the same transaction', async () => {
    const database = {
      transaction: async (_c: unknown, fn: (runner: unknown) => unknown) => fn(tx),
    } as unknown as TenantDatabase;
    const projects = {
      create: vi.fn(async () => ({
        id: 'p-1',
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        name: 'Atlas',
        status: 'active',
        ownerUserId: 'u-creator',
        committedAt: null,
        forecastAt: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      })),
    } as unknown as ProjectsRepository;
    const add = vi.fn(async (_r: unknown, _c: unknown, input: Record<string, string>) => ({
      id: 'pm-1',
      ...input,
    }));
    const record = vi.fn(async () => undefined);
    const service = new ProjectsService(
      database,
      projects,
      { record } as unknown as AuditService,
      { add } as unknown as ProjectMembershipsRepository,
    );

    await service.create(context, { workspaceId: 'ws-1', name: 'Atlas' });

    expect(add).toHaveBeenCalledWith(tx, context, {
      projectId: 'p-1',
      userId: 'u-creator',
      role: 'manager',
    });
    expect(record).toHaveBeenCalledWith(
      tx,
      context,
      expect.objectContaining({ action: 'project_membership.granted', objectId: 'pm-1' }),
    );
  });
});
