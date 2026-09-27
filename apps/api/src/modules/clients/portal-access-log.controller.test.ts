import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  PortalAccessLogController,
  PortalAccessLogService,
} from './portal-access-log.controller.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type {
  ListPortalAccessOptions,
  PortalAccessLogRepository,
  RecordPortalAccessInput,
} from './portal-access-log.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PortalAccessLogRow, ProjectRow } from '../../common/database/schema.js';

/**
 * SEC / Client portal access log (x237) — the record helper and the internal audit read, over fakes
 * with **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories. `authorize()` is the real
 * policy, so these cases prove the actual security decisions: a client's read records an event, an
 * internal manager lists it, an internal principal's own portal preview records nothing (the log is
 * a record of *client* access), an unknown `resource_kind` is refused before the table, and a
 * cross-tenant or unmanageable `projectId` is a 404 with no read. The route ceiling that turns a
 * client into a 403 on this internal path is pinned by the `@RequireCapability` metadata. No DB in
 * this suite (the chain owns the round-trip and the migrator proof).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const INTERNAL_USER = 'user-internal-1';
const PROJECT = 'project-visible';

function internalManager(): Principal {
  return {
    userId: INTERNAL_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-internal-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: INTERNAL_USER } as unknown as TenantContext;
const clientContext = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function fakeProjects(existing: readonly string[]): ProjectsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ProjectRow) : null),
  } as unknown as ProjectsRepository;
}

function fakeLog(): {
  repo: PortalAccessLogRepository;
  recorded: RecordPortalAccessInput[];
  rows: PortalAccessLogRow[];
} {
  const recorded: RecordPortalAccessInput[] = [];
  const rows: PortalAccessLogRow[] = [];
  let seq = 0;
  const repo = {
    record: (_r: never, _c: TenantContext, input: RecordPortalAccessInput) => {
      recorded.push(input);
      seq += 1;
      const row = {
        id: `a-${seq}`,
        organizationId: ORG,
        projectId: input.projectId,
        clientMemberId: input.clientMemberId,
        resourceKind: input.resourceKind,
        accessedAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
      } as unknown as PortalAccessLogRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    list: (_r: never, _c: TenantContext, options: ListPortalAccessOptions) =>
      Promise.resolve([...rows].reverse().filter((row) => row.projectId === options.projectId)),
  } as unknown as PortalAccessLogRepository;
  return { repo, recorded, rows };
}

function serviceFor(
  existingProjects: readonly string[],
  log: ReturnType<typeof fakeLog>,
): PortalAccessLogService {
  return new PortalAccessLogService(fakeDatabase(), fakeProjects(existingProjects), log.repo);
}

describe('PortalAccessLogService (x237)', () => {
  it('records a client access event and lists it for an internal manager', async () => {
    const store = fakeLog();
    const service = serviceFor([PROJECT], store);

    await service.record(clientContext, clientPrincipal(PROJECT), {
      projectId: PROJECT,
      resourceKind: 'deliverable',
    });

    // The recorded event is attributed to the client membership, never a body field.
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toMatchObject({
      projectId: PROJECT,
      clientMemberId: 'membership-client-1',
      resourceKind: 'deliverable',
    });

    const listed = await service.listForProject(context, internalManager(), { projectId: PROJECT });
    expect(listed.map((e) => e.resourceKind)).toEqual(['deliverable']);
    expect(listed[0]?.clientMemberId).toBe('membership-client-1');
  });

  it('records nothing for an internal principal — the log is a record of client access', async () => {
    const store = fakeLog();
    const service = serviceFor([PROJECT], store);

    await service.record(context, internalManager(), {
      projectId: PROJECT,
      resourceKind: 'update',
    });

    expect(store.recorded).toHaveLength(0);
  });

  it('records nothing for a client who cannot read the project', async () => {
    const store = fakeLog();
    const service = serviceFor([PROJECT], store);

    // The client's shared project is PROJECT; recording another project is not their access.
    await service.record(clientContext, clientPrincipal(PROJECT), {
      projectId: 'project-someone-elses',
      resourceKind: 'deliverable',
    });

    expect(store.recorded).toHaveLength(0);
  });

  it('refuses an unknown resource_kind with 400 and writes nothing', async () => {
    const store = fakeLog();
    const service = serviceFor([PROJECT], store);

    await expect(
      service.record(clientContext, clientPrincipal(PROJECT), {
        projectId: PROJECT,
        resourceKind: 'password' as never,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.recorded).toHaveLength(0);
  });

  it('answers 404 for an unknown or cross-tenant projectId on the internal read', async () => {
    const store = fakeLog();
    const service = serviceFor([PROJECT], store); // the named project does NOT exist

    await expect(
      service.listForProject(context, internalManager(), { projectId: 'project-elsewhere' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 when the caller cannot manage the project (a client never can)', async () => {
    const store = fakeLog();
    const service = serviceFor([PROJECT], store);

    await expect(
      service.listForProject(clientContext, clientPrincipal(PROJECT), { projectId: PROJECT }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * The route ceiling that produces the client → 403 on the internal audit path.
 *
 * A client role never holds `project.manage`, so `CapabilityGuard` refuses this route with 403
 * before the handler runs — the guard reads exactly the `@RequireCapability` metadata asserted here.
 * There is no `/portal` route to the access log at all: it is internal, never projected to a client.
 */
describe('portal access log route capability', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the internal audit read with project.manage', () => {
    expect(capabilityOf(PortalAccessLogController.prototype, 'list')).toBe('project.manage');
  });
});
