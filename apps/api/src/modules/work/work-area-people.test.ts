import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemsController } from './work-items.controller.js';
import { WorkItemsService } from './work-items.service.js';
import { applyPeopleChange } from './work-item-people.service.js';
import type { PeopleWritePorts } from './work-item-people.service.js';
import { WorkAiPeopleGate } from './work-ai-people.js';
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
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';

/**
 * Work area (2026-11-23), slice W-API-1 — a new work carries its people, client companies and
 * first steps in one request and one transaction; an update replaces the people as sets; the
 * doer rows are the single source with the owner as their lead. Real controller, real service,
 * real `authorize`; in-memory repositories (the SQL round-trip is the DB suite's).
 */

const ORG = 'org-1';
const PROJECT = 'proj-1';
const ME = 'u-me';
const context = { organizationId: ORG, userId: ME, correlationId: 'c-1' } as TenantContext;
const owner: Principal = {
  userId: ME,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-me',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: true,
};
const MEMBERS = new Set([ME, 'u-a', 'u-b', 'u-sup', 'u-watch']);

function harness() {
  const rows = new Map<string, WorkItemRow>();
  const roles = new Map<string, string[]>(); // `${itemId}:${role}` → user ids
  const watching = new Map<string, string[]>();
  const steps: string[] = [];
  const clients: string[][] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const repoUpdates: Record<string, unknown>[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (t: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const workItems = {
    create: async (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
      seq += 1;
      const row = {
        id: `wi-${seq}`,
        organizationId: ORG,
        projectId: input['projectId'],
        type: 'task',
        title: input['title'],
        description: null,
        state: 'backlog',
        ownerUserId: (input['ownerUserId'] as string | undefined) ?? null,
        audience: (input['audience'] as string | undefined) ?? 'internal',
        startAt: null,
        dueAt: null,
        completedAt: null,
        version: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      } as unknown as WorkItemRow;
      rows.set(row.id, row);
      // The repository writes the owner's doer row itself (0412).
      if (row.ownerUserId) roles.set(`${row.id}:doer`, [row.ownerUserId]);
      return row;
    },
    findById: async (_r: unknown, _c: unknown, id: string) => rows.get(id) ?? null,
    requireById: async (_r: unknown, _c: unknown, id: string) => rows.get(id) as WorkItemRow,
    update: async (
      _r: unknown,
      _c: unknown,
      id: string,
      _version: number,
      input: Record<string, unknown>,
    ) => {
      repoUpdates.push(input);
      const before = rows.get(id) as WorkItemRow;
      const next = {
        ...before,
        ...(input['ownerUserId'] === undefined ? {} : { ownerUserId: input['ownerUserId'] }),
        version: Number(before.version) + 1,
      } as WorkItemRow;
      rows.set(id, next);
      return next;
    },
  } as unknown as WorkItemsRepository;

  const assignees = {
    activeMemberships: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      new Map(ids.filter((id) => MEMBERS.has(id)).map((id) => [id, `m-${id}`])),
    list: async (_r: unknown, _c: unknown, id: string) => [
      ...(roles.get(`${id}:doer`) ?? []).map((userId) => ({ userId, role: 'doer' })),
      ...(roles.get(`${id}:supervisor`) ?? []).map((userId) => ({ userId, role: 'supervisor' })),
    ],
    watcherUserIds: async (_r: unknown, _c: unknown, id: string) => watching.get(id) ?? [],
    replaceRole: async (
      _r: unknown,
      _c: unknown,
      id: string,
      role: string,
      membershipIds: readonly string[],
    ) =>
      void roles.set(
        `${id}:${role}`,
        membershipIds.map((m) => m.replace(/^m-/, '')),
      ),
    setLead: async (_r: unknown, _c: unknown, id: string, lead: string | null) => {
      const row = rows.get(id) as WorkItemRow;
      rows.set(id, { ...row, ownerUserId: lead, version: Number(row.version) + 1 } as WorkItemRow);
    },
    doersFor: async () => new Map(),
  } as unknown as WorkItemAssigneesRepository;
  const watchers = {
    create: async (_r: unknown, _c: unknown, input: { workItemId: string; memberId: string }) =>
      void watching.set(input.workItemId, [
        ...(watching.get(input.workItemId) ?? []),
        input.memberId.replace(/^m-/, ''),
      ]),
    deleteForMember: async (_r: unknown, _c: unknown, id: string, memberId: string) =>
      void watching.set(
        id,
        (watching.get(id) ?? []).filter((userId) => `m-${userId}` !== memberId),
      ),
  } as unknown as WorkWatchersRepository;
  const checklist = {
    create: async (_r: unknown, _c: unknown, input: { label: string }) =>
      void steps.push(input.label),
  } as unknown as WorkChecklistRepository;
  const audit = {
    record: async (
      _r: unknown,
      _c: unknown,
      entry: { action: string; metadata: Record<string, unknown> },
    ) => void audits.push(entry),
  } as unknown as AuditService;
  const outbox = {
    append: async (
      _r: unknown,
      _c: unknown,
      event: { type: string; payload: Record<string, unknown> },
    ) => void events.push(event),
  } as unknown as OutboxEventsRepository;

  // 60-08: everyone here is a person, so the AI-employee rules are the real gate's no-op.
  const peopleOnly = new WorkAiPeopleGate(
    true,
    {
      kinds: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
        new Map(
          ids
            .filter((id) => MEMBERS.has(id))
            .map((id) => [id, { membershipId: `m-${id}`, kind: 'human' as const }]),
        ),
    },
    { read: async () => Promise.reject(new Error('no AI employee here')) },
  );
  const service = new WorkItemsService(
    database,
    workItems,
    audit,
    {
      findById: async (_r: unknown, _c: unknown, id: string) =>
        id === PROJECT ? { id, organizationId: ORG, archivedAt: null } : null,
    } as unknown as ProjectsRepository,
    outbox,
    {
      isActiveInternalMember: async (_r: unknown, _c: unknown, id: string) => MEMBERS.has(id),
    } as unknown as WorkGraphRepository,
    {
      list: async () => [
        { clientOrganizationId: 'client-a' },
        { clientOrganizationId: 'client-b' },
      ],
    } as unknown as ProjectClientsRepository,
    {} as unknown as ProjectMembershipsRepository,
    {} as unknown as ObjectiveWorkLinksRepository,
    {} as unknown as WorkItemFilesRepository,
    {
      list: async () => [],
      replace: async (_r: unknown, _c: unknown, _id: string, ids: readonly string[]) =>
        void clients.push([...ids]),
    } as unknown as WorkItemClientAudienceRepository,
    assignees,
    watchers,
    checklist,
    undefined,
    peopleOnly,
  );
  return {
    controller: new WorkItemsController(service),
    rows,
    roles,
    watching,
    steps,
    clients,
    audits,
    events,
    repoUpdates,
    ports: { assignees, watchers, audit, outbox, ai: peopleOnly } as PeopleWritePorts,
  };
}

describe('W-API-1: a work carries its people, client and steps from the start', () => {
  it('creates with several doers (lead first), a supervisor, a watcher, a client and steps', async () => {
    const h = harness();
    const created = await h.controller.create(context, owner, {
      projectId: PROJECT,
      title: 'Design the landing page',
      doerUserIds: ['u-a', 'u-b', 'u-a'],
      supervisorUserIds: ['u-sup'],
      watcherUserIds: ['u-watch'],
      audience: 'client_visible',
      clientOrganizationIds: ['client-a'],
      steps: [{ label: ' Research ' }, { label: 'Wireframe' }],
    });

    expect(created.ownerUserId).toBe('u-a');
    expect(h.roles.get(`${created.id}:doer`)).toEqual(['u-a', 'u-b']);
    expect(h.roles.get(`${created.id}:supervisor`)).toEqual(['u-sup']);
    expect(h.watching.get(created.id)).toEqual(['u-watch']);
    expect(h.steps).toEqual(['Research', 'Wireframe']);
    expect(h.clients).toEqual([['client-a']]);
    const createdAudit = h.audits.find((a) => a.action === 'work_item.created');
    expect(createdAudit?.metadata).toMatchObject({
      doers: 2,
      supervisors: 1,
      watchers: 1,
      steps: 2,
      clients_listed: 1,
      audience: 'client_visible',
    });
    // Everyone newly given a role is told, through the outbox, in the same unit of work.
    const told = h.events.filter((e) => e.type === 'work_item.people_assigned.v1');
    expect(told.map((e) => [e.payload['role'], e.payload['userIds']])).toEqual([
      ['doer', ['u-b']],
      ['supervisor', ['u-sup']],
    ]);
  });

  it('puts an owner named beside the doers first, so owner and doers never disagree', async () => {
    const h = harness();
    const created = await h.controller.create(context, owner, {
      projectId: PROJECT,
      title: 'Brief',
      ownerUserId: 'u-b',
      doerUserIds: ['u-a'],
    });
    expect(created.ownerUserId).toBe('u-b');
    expect(h.roles.get(`${created.id}:doer`)).toEqual(['u-b', 'u-a']);
  });

  it('refuses client companies on an internal item, and a non-member, writing nothing', async () => {
    const h = harness();
    await expect(
      h.controller.create(context, owner, {
        projectId: PROJECT,
        title: 'Brief',
        clientOrganizationIds: ['client-a'],
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      h.controller.create(context, owner, {
        projectId: PROJECT,
        title: 'Brief',
        audience: 'client_visible',
        clientOrganizationIds: ['client-z'],
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      h.controller.create(context, owner, {
        projectId: PROJECT,
        title: 'Brief',
        supervisorUserIds: ['u-stranger'],
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(h.steps).toEqual([]);
    expect(h.clients).toEqual([]);
  });

  it('refuses malformed people lists and steps with 400', async () => {
    const h = harness();
    for (const body of [
      { doerUserIds: 'u-a' },
      { supervisorUserIds: [''] },
      { watcherUserIds: Array.from({ length: 51 }, (_, i) => `u-${i}`) },
      { steps: [{ label: '' }] },
      { steps: [{ name: 'x' }] },
      { steps: Array.from({ length: 51 }, () => ({ label: 'x' })) },
    ]) {
      await expect(
        h.controller.create(context, owner, { projectId: PROJECT, title: 'T', ...body }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      h.controller.list(context, owner, undefined, undefined, undefined, undefined, ''),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('PATCH replaces the people as sets: the first doer leads, the audit counts the change', async () => {
    const h = harness();
    const created = await h.controller.create(context, owner, {
      projectId: PROJECT,
      title: 'Brief',
      doerUserIds: ['u-a'],
      watcherUserIds: ['u-watch'],
    });
    h.audits.length = 0;
    const updated = await h.controller.update(context, owner, created.id, {
      version: created.version,
      doerUserIds: ['u-b', 'u-a'],
      supervisorUserIds: ['u-sup'],
      watcherUserIds: [],
    });
    expect(h.repoUpdates.at(-1)).toMatchObject({ ownerUserId: 'u-b' });
    expect(updated.ownerUserId).toBe('u-b');
    expect(h.roles.get(`${created.id}:doer`)).toEqual(['u-b', 'u-a']);
    expect(h.watching.get(created.id)).toEqual([]);
    const people = h.audits.find((a) => a.action === 'work_item.people_changed');
    expect(people?.metadata).toMatchObject({
      doers_before: 1,
      doers_after: 2,
      supervisors_before: 0,
      supervisors_after: 1,
      watchers_before: 1,
      watchers_after: 0,
      lead_changed: true,
    });
  });
});

describe('W-API-1: the shared people writer', () => {
  it('never tells the actor about their own role, and writes no audit row for no change', async () => {
    const h = harness();
    const created = await h.controller.create(context, owner, {
      projectId: PROJECT,
      title: 'Mine',
      doerUserIds: [ME],
    });
    expect(h.events.filter((e) => e.type === 'work_item.people_assigned.v1')).toEqual([]);
    h.audits.length = 0;
    await applyPeopleChange({} as never, context, h.ports, h.rows.get(created.id) as WorkItemRow, {
      doerUserIds: [ME],
    });
    expect(h.audits).toEqual([]);
  });
});
