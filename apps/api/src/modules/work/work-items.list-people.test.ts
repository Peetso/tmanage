import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemsService } from './work-items.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { WorkGraphRepository } from './work-graph.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import type { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import type { ObjectiveWorkLinksRepository } from '../projects/objective-work-links.repository.js';
import type { WorkItemFilesRepository } from './item-files.repository.js';
import type { WorkItemClientAudienceRepository } from './work-item-client-audience.repository.js';
import type { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import type { WorkWatchersRepository } from './watchers.repository.js';
import type { WorkChecklistRepository } from './work-checklist.repository.js';
import type { WorkStagesRepository } from './stages/stages.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';

/**
 * Work area list (WW2, 2026-11-23): every row of the Works list and every board card shows its
 * doers, its supervisor and its client (Figma WV2-01). The list reads them in a fixed number of
 * batched reads per page, for internal readers only. In-memory repositories; the SQL is the DB
 * suite's.
 */

const ORG = 'org-1';
const context = { organizationId: ORG, userId: 'u-me', correlationId: 'c-1' } as TenantContext;
const internal: Principal = {
  userId: 'u-me',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-me',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: ['p1', 'p2'],
  hasOrgWideScope: true,
};
const client: Principal = {
  ...internal,
  userId: 'u-client',
  kind: 'client',
  role: 'client',
  clientOrganizationId: 'client-a',
  hasOrgWideScope: false,
} as Principal;

function row(id: string, projectId: string, audience: string, ownerUserId: string | null) {
  return {
    id,
    organizationId: ORG,
    projectId,
    type: 'task',
    title: id,
    description: null,
    state: 'in_progress',
    ownerUserId,
    audience,
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  } as unknown as WorkItemRow;
}

const ROWS = [
  row('w-internal', 'p1', 'internal', 'u-a'),
  row('w-narrowed', 'p1', 'client_visible', 'u-b'),
  row('w-project', 'p2', 'client_action_required', null),
];

function service() {
  const reads: string[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { list: async () => ROWS } as unknown as WorkItemsRepository;
  const assignees = {
    doersFor: async (_r: unknown, _c: unknown, ids: readonly string[], role = 'doer') => {
      reads.push(`${role}:${ids.length}`);
      return role === 'doer'
        ? new Map([['w-internal', ['u-a', 'u-c']]])
        : new Map([['w-narrowed', ['u-sup']]]);
    },
  } as unknown as WorkItemAssigneesRepository;
  const clientAudience = {
    listMany: async (_r: unknown, _c: unknown, ids: readonly string[]) => {
      reads.push(`narrowed:${ids.join(',')}`);
      return new Map([['w-narrowed', ['client-b']]]);
    },
  } as unknown as WorkItemClientAudienceRepository;
  const projectClients = {
    clientsOfProjects: async (_r: unknown, _c: unknown, projectIds: readonly string[]) => {
      reads.push(`projects:${projectIds.join(',')}`);
      return new Map([
        ['p1', ['client-a', 'client-b']],
        ['p2', ['client-a']],
      ]);
    },
  } as unknown as ProjectClientsRepository;
  const stages = {
    effectiveForMany: async () => new Map(),
  } as unknown as WorkStagesRepository;
  const instance = new WorkItemsService(
    database,
    workItems,
    {} as unknown as AuditService,
    {} as unknown as ProjectsRepository,
    {} as unknown as OutboxEventsRepository,
    {} as unknown as WorkGraphRepository,
    projectClients,
    {} as unknown as ProjectMembershipsRepository,
    {} as unknown as ObjectiveWorkLinksRepository,
    {} as unknown as WorkItemFilesRepository,
    clientAudience,
    assignees,
    {} as unknown as WorkWatchersRepository,
    {} as unknown as WorkChecklistRepository,
    stages,
  );
  return { instance, reads };
}

describe('WW2: the Works list rows carry doers, supervisor and client', () => {
  it('reads each in one batched read per page and fills every row', async () => {
    const { instance, reads } = service();
    const views = await instance.list(context, internal, {});
    const byId = new Map(views.map((view) => [view.id, view]));

    expect(byId.get('w-internal')).toMatchObject({
      doerUserIds: ['u-a', 'u-c'],
      supervisorUserIds: [],
      clientOrganizationIds: [],
    });
    // A client-facing row narrowed to some companies names those; otherwise the project's.
    expect(byId.get('w-narrowed')).toMatchObject({
      supervisorUserIds: ['u-sup'],
      clientOrganizationIds: ['client-b'],
    });
    expect(byId.get('w-project')).toMatchObject({ clientOrganizationIds: ['client-a'] });
    // Only the client-facing rows are asked about, and each project once.
    expect(reads).toEqual([
      'doer:3',
      'supervisor:3',
      'narrowed:w-narrowed,w-project',
      'projects:p1,p2',
    ]);
  });

  it('tells a client reader none of it', async () => {
    const { instance, reads } = service();
    const views = await instance.list(context, client, {});
    for (const view of views) {
      expect(view).not.toHaveProperty('supervisorUserIds');
      expect(view).not.toHaveProperty('clientOrganizationIds');
    }
    expect(reads).toEqual([]);
  });
});
