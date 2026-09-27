import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  PortalUpdateCommentsController,
  ProjectUpdateCommentsController,
} from './update-comments.controller.js';
import { UpdateCommentsService } from './update-comments.service.js';
import type {
  CreateUpdateCommentInput,
  ProjectUpdateCommentsRepository,
} from './update-comments.repository.js';
import type { ProjectUpdatesRepository } from './project-updates.repository.js';
import type { ProjectUpdateCommentRow, ProjectUpdateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SEC / Portal update comments (x203) — the internal write/read and the client projection, over
 * fakes with **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories; `authorize()` is the real
 * policy, so these cases prove the actual security decisions: an internal manager posts as the
 * context user and lists the full record; a client reads only their own project's *published*
 * update's comments and never the author; a cross-tenant or other-project id is a 404 with no
 * write; and the route ceiling refuses a client's POST with 403. No DB in this suite (the chain
 * owns the round-trip and the migrator proof).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const INTERNAL_USER = 'user-internal-1';
const PROJECT = 'project-visible';
const UPDATE = 'update-1';

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

/** A project-updates repo that resolves exactly the update rows it was seeded with (tenant-scoped). */
function fakeUpdates(rows: readonly Partial<ProjectUpdateRow>[]): ProjectUpdatesRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve((rows.find((row) => row.id === id) as ProjectUpdateRow | undefined) ?? null),
  } as unknown as ProjectUpdatesRepository;
}

/** A stateful comments store: `create` appends, `listForUpdate` filters by update id. */
function fakeComments(): {
  repo: ProjectUpdateCommentsRepository;
  created: CreateUpdateCommentInput[];
  rows: ProjectUpdateCommentRow[];
} {
  const created: CreateUpdateCommentInput[] = [];
  const rows: ProjectUpdateCommentRow[] = [];
  let seq = 0;
  const repo = {
    create: (_r: never, _c: TenantContext, input: CreateUpdateCommentInput) => {
      created.push(input);
      seq += 1;
      const row = {
        id: `c-${seq}`,
        organizationId: ORG,
        updateId: input.updateId,
        body: input.body,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(`2026-09-2${seq}T00:00:00.000Z`),
      } as unknown as ProjectUpdateCommentRow;
      rows.push(row);
      return Promise.resolve(row);
    },
    listForUpdate: (_r: never, _c: TenantContext, updateId: string) =>
      Promise.resolve(rows.filter((row) => row.updateId === updateId)),
  } as unknown as ProjectUpdateCommentsRepository;
  return { repo, created, rows };
}

function serviceFor(
  updates: readonly Partial<ProjectUpdateRow>[],
  comments: ReturnType<typeof fakeComments>,
): UpdateCommentsService {
  return new UpdateCommentsService(fakeDatabase(), fakeUpdates(updates), comments.repo);
}

const publishedUpdate: Partial<ProjectUpdateRow> = {
  id: UPDATE,
  projectId: PROJECT,
  published: true,
};

describe('UpdateCommentsService (x203)', () => {
  it('posts as the context user and both the internal and client reads show the comment', async () => {
    const store = fakeComments();
    const service = serviceFor([publishedUpdate], store);

    const created = await service.post(context, internalManager(), PROJECT, UPDATE, {
      body: 'Draft ready for review',
    });

    // The author is the context user, never a body field.
    expect(store.created[0]?.createdByUserId).toBe(INTERNAL_USER);
    expect(created).toMatchObject({ updateId: UPDATE, createdByUserId: INTERNAL_USER });

    const internal = await service.listInternal(context, internalManager(), PROJECT, UPDATE);
    expect(internal.map((c) => c.body)).toEqual(['Draft ready for review']);

    const client = await service.listForClient(
      clientContext,
      clientPrincipal(PROJECT),
      PROJECT,
      UPDATE,
    );
    // The client sees the comment but never the staff identity (§4 excludes staff).
    expect(client.map((c) => c.body)).toEqual(['Draft ready for review']);
    expect(Object.keys(client[0]!).sort()).toEqual(
      ['body', 'createdAt', 'id', 'projectId', 'updateId'].sort(),
    );
    expect(client[0]).not.toHaveProperty('createdByUserId');
  });

  it('answers 404 and writes nothing for an update in another project (or tenant)', async () => {
    const store = fakeComments();
    // The update belongs to a different project; naming PROJECT must not reach it.
    const service = serviceFor(
      [{ id: UPDATE, projectId: 'project-elsewhere', published: true }],
      store,
    );

    await expect(
      service.post(context, internalManager(), PROJECT, UPDATE, { body: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.created).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the caller cannot manage the project', async () => {
    const store = fakeComments();
    const service = serviceFor([publishedUpdate], store);

    // A client principal never holds `project.manage`; the update resolves, authorize denies.
    await expect(
      service.post(clientContext, clientPrincipal(PROJECT), PROJECT, UPDATE, { body: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.created).toHaveLength(0);
  });

  it('answers 404 when a client reads comments on an unpublished update', async () => {
    const store = fakeComments();
    const service = serviceFor([{ id: UPDATE, projectId: PROJECT, published: false }], store);

    await expect(
      service.listForClient(clientContext, clientPrincipal(PROJECT), PROJECT, UPDATE),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 when a client reads a project outside their own scope', async () => {
    const store = fakeComments();
    const service = serviceFor([publishedUpdate], store);

    await expect(
      service.listForClient(
        clientContext,
        clientPrincipal(PROJECT),
        'project-someone-elses',
        UPDATE,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * The route ceiling that produces the client → 403 on the internal path. A client role never holds
 * `project.manage`, so `CapabilityGuard` refuses the internal post/list with 403 before the handler
 * runs; the client route requires `client_projection.read` instead. The live round-trip is the
 * chain's e2e; this pins the wiring the guard depends on.
 */
describe('update-comments route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the internal post and list with project.manage', () => {
    expect(capabilityOf(ProjectUpdateCommentsController.prototype, 'post')).toBe('project.manage');
    expect(capabilityOf(ProjectUpdateCommentsController.prototype, 'list')).toBe('project.manage');
  });

  it('guards the client projection with client_projection.read', () => {
    expect(capabilityOf(PortalUpdateCommentsController.prototype, 'list')).toBe(
      'client_projection.read',
    );
  });
});
