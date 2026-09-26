import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  PortalRisksController,
  ProjectRisksController,
  ProjectRisksService,
} from './project-risks.controller.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type {
  CreateProjectRiskInput,
  ListProjectRisksOptions,
  ProjectRisksRepository,
} from './project-risks.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRiskRow, ProjectRow } from '../../common/database/schema.js';

/**
 * SEC / Portal risks (x140) — internal write/read and the client projection, over fakes with
 * **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories. `authorize()` is the real
 * policy, so these cases prove the actual security decisions: an internal manager may record and
 * list the full record (with the internal note), a client may read only their own project's
 * *published* risks, an unpublished risk is never projected, the client view leaks no title, no
 * internal note and no staff identity, and a cross-tenant or cross-client `projectId` is a 404 with
 * no write. The client-audience boundary ({@link toClientRiskView} dropping
 * `title`/`internalNote`/`createdByUserId`/`published`) is the substance and the revert proof pins
 * it. No DB in this suite (the chain owns the round-trip and the migrator proof).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const INTERNAL_USER = 'user-internal-1';
const PROJECT = 'project-visible';

/** An internal manager with org-wide scope — holds `project.manage` and passes the relation. */
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

/** A client viewer whose single shared project is `readableProjectId`. */
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

/** A fake database whose `read` and `transaction` both run the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A projects repo that resolves exactly the ids it was told exist (tenant-scoped `findById`). */
function fakeProjects(existing: readonly string[]): ProjectsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ProjectRow) : null),
  } as unknown as ProjectsRepository;
}

/** A stateful risks store: `create` appends, `list` filters by project + published gate. */
function fakeRisks(): {
  repo: ProjectRisksRepository;
  created: CreateProjectRiskInput[];
  rows: ProjectRiskRow[];
} {
  const created: CreateProjectRiskInput[] = [];
  const rows: ProjectRiskRow[] = [];
  let seq = 0;
  const repo = {
    create: (_r: never, _c: TenantContext, input: CreateProjectRiskInput) => {
      created.push(input);
      seq += 1;
      const row = {
        id: `r-${seq}`,
        organizationId: ORG,
        projectId: input.projectId,
        title: input.title,
        severity: input.severity,
        status: input.status,
        internalNote: input.internalNote,
        clientSummary: input.clientSummary,
        published: input.published,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
        updatedAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
      } as unknown as ProjectRiskRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    list: (_r: never, _c: TenantContext, options: ListProjectRisksOptions) =>
      Promise.resolve(
        rows.filter(
          (row) => row.projectId === options.projectId && (!options.publishedOnly || row.published),
        ),
      ),
  } as unknown as ProjectRisksRepository;
  return { repo, created, rows };
}

function serviceFor(
  existingProjects: readonly string[],
  risks: ReturnType<typeof fakeRisks>,
): ProjectRisksService {
  return new ProjectRisksService(fakeDatabase(), fakeProjects(existingProjects), risks.repo);
}

describe('ProjectRisksService (x140)', () => {
  it('records as the context user and lists the full internal record, including the internal note', async () => {
    const store = fakeRisks();
    const service = serviceFor([PROJECT], store);

    const created = await service.create(context, internalManager(), {
      projectId: PROJECT,
      title: 'Vendor slippage',
      severity: 'high',
      status: 'open',
      internalNote: 'Supplier missed two check-ins; escalate before the client notices.',
      clientSummary: 'We are watching a delivery dependency and have a mitigation in hand.',
      published: true,
    });

    // The author is the context user, never a body field.
    expect(store.created[0]?.createdByUserId).toBe(INTERNAL_USER);
    // The internal view carries the full record — severity, status, note and author.
    expect(created).toMatchObject({
      severity: 'high',
      status: 'open',
      internalNote: 'Supplier missed two check-ins; escalate before the client notices.',
      createdByUserId: INTERNAL_USER,
    });

    const listed = await service.listInternal(context, internalManager(), PROJECT);
    expect(listed.map((r) => r.title)).toEqual(['Vendor slippage']);
    expect(listed[0]?.internalNote).toContain('escalate');
  });

  it('projects only published risks to a client and never the title, internal note, author or publish flag', async () => {
    const store = fakeRisks();
    const service = serviceFor([PROJECT], store);
    const manager = internalManager();

    await service.create(context, manager, {
      projectId: PROJECT,
      title: 'Scope creep',
      severity: 'medium',
      status: 'open',
      internalNote: 'Client keeps adding pages; margin at risk — do not surface the margin.',
      clientSummary: 'A few late additions may affect the timeline; we will confirm dates.',
      published: true,
    });
    await service.create(context, manager, {
      projectId: PROJECT,
      title: 'Internal draft risk',
      severity: 'low',
      status: 'open',
      internalNote: 'Not for the client yet.',
      clientSummary: 'draft summary',
      published: false,
    });

    const seen = await service.listForClient(clientContext, clientPrincipal(PROJECT), PROJECT);

    // The unpublished risk is never projected; only the published one is, by its client summary.
    expect(seen.map((r) => r.clientSummary)).toEqual([
      'A few late additions may affect the timeline; we will confirm dates.',
    ]);
    // The client view carries exactly the client-safe fields — nothing internal.
    expect(Object.keys(seen[0]!).sort()).toEqual(
      ['clientSummary', 'createdAt', 'id', 'projectId', 'severity', 'status'].sort(),
    );
    expect(seen[0]).not.toHaveProperty('title');
    expect(seen[0]).not.toHaveProperty('internalNote');
    expect(seen[0]).not.toHaveProperty('createdByUserId');
    expect(seen[0]).not.toHaveProperty('published');
  });

  it('answers 404 and writes nothing for an unknown or cross-tenant projectId', async () => {
    const store = fakeRisks();
    const service = serviceFor([PROJECT], store); // the named project does NOT exist

    await expect(
      service.create(context, internalManager(), {
        projectId: 'project-elsewhere',
        title: 'X',
        severity: 'low',
        status: 'open',
        internalNote: null,
        clientSummary: 'y',
        published: true,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // The Known-trap guarantee: no write on a project that does not resolve in this tenant.
    expect(store.created).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the caller cannot manage the project', async () => {
    const store = fakeRisks();
    const service = serviceFor([PROJECT], store);

    // A client principal never holds `project.manage`; the project resolves, authorize denies.
    await expect(
      service.create(context, clientPrincipal(PROJECT), {
        projectId: PROJECT,
        title: 'X',
        severity: 'low',
        status: 'open',
        internalNote: null,
        clientSummary: 'y',
        published: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.created).toHaveLength(0);
  });

  it('answers 404 when a client reads a project outside their own scope', async () => {
    const store = fakeRisks();
    const service = serviceFor([PROJECT], store);

    await expect(
      service.listForClient(clientContext, clientPrincipal(PROJECT), 'project-someone-elses'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * The route-ceiling that produces the client → 403 on the internal path.
 *
 * A client role never holds `project.manage`, so `CapabilityGuard` refuses the internal routes with
 * 403 before the handler runs — the guard reads exactly the `@RequireCapability` metadata asserted
 * here. The client route requires `client_projection.read` instead. The live 403/guard round-trip is
 * the chain's e2e; this pins the wiring the guard depends on.
 */
describe('risks route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the internal create and list with project.manage', () => {
    expect(capabilityOf(ProjectRisksController.prototype, 'create')).toBe('project.manage');
    expect(capabilityOf(ProjectRisksController.prototype, 'list')).toBe('project.manage');
  });

  it('guards the client projection with client_projection.read', () => {
    expect(capabilityOf(PortalRisksController.prototype, 'list')).toBe('client_projection.read');
  });
});
