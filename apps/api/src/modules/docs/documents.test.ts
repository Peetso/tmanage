import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocumentsService } from './documents.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentRow } from '../../common/database/schema.js';

/**
 * DOC-01 (x91) service proofs, database-free over the module's fakes. The migration and the
 * tenant-scoped SQL round-trip are proven separately in `apps/api/test/migrator.db.test.ts`
 * (`0030: documents …`) and `apps/api/test/doc-001-documents.db.test.ts`; here the subject is the
 * service's own logic — create-then-read, empty, and the relation filter that drops a
 * cross-tenant or non-member row.
 *
 * The fake `list` deliberately does **not** apply the tenant scope the real SQL applies, so a
 * cross-tenant row reaches the service and its `authorize()` filter must drop it — belt-and-braces
 * to the scoped query, exactly as the meetings service test does.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** A service over an in-memory store whose `list` omits the tenant scope on purpose. */
function serviceWith(seed: readonly DocumentRow[] = []): {
  service: DocumentsService;
  store: DocumentRow[];
} {
  const store: DocumentRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (
      _runner: unknown,
      _ctx: unknown,
      options: { readonly projectId: string; readonly after?: string },
    ) =>
      store.filter(
        (row) =>
          row.projectId === options.projectId &&
          (options.after === undefined || row.id > options.after),
      ),
    // Deliberately unscoped, like `list`: a cross-tenant row reaches the service so its
    // `authorize()` guard must drop it, and an unknown id simply is not in the store.
    findById: async (_runner: unknown, _ctx: unknown, documentId: string) =>
      store.find((row) => row.id === documentId) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly title: string;
        readonly body: string;
        readonly createdByUserId: string;
      },
    ) => {
      const row = {
        id: `document-0000-0000-0000-0000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as DocumentRow;
      store.push(row);
      return row;
    },
  } as unknown as DocumentsRepository;
  // A tenant-scoped project lookup: `PROJECT` exists in the acting tenant, everything else is
  // absent (a missing id, or one that belongs to another tenant, resolves to null). This is the
  // resolution `DocumentsService.create` does before the relation check so an org-wide caller
  // naming a non-existent project gets 404 rather than a foreign-key 500.
  const projects = {
    findById: async (_runner: unknown, _ctx: unknown, projectId: string) =>
      projectId === PROJECT ? { id: PROJECT, organizationId: ORG } : null,
  } as unknown as ProjectsRepository;
  return { service: new DocumentsService(database, repository, projects), store };
}

describe('DocumentsService', () => {
  it('creates a document, then reads it back for a project member', async () => {
    const { service } = serviceWith();
    const created = await service.create(context, member([PROJECT]), {
      projectId: PROJECT,
      title: 'Kickoff brief',
      body: 'the body prose',
    });

    expect(created.projectId).toBe(PROJECT);
    expect(created.title).toBe('Kickoff brief');
    expect(created.body).toBe('the body prose');
    expect(created.createdByUserId).toBe(USER);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed.map((d) => d.id)).toEqual([created.id]);
    expect(listed[0]?.body).toBe('the body prose');
  });

  it('reads an empty project as empty', async () => {
    const { service } = serviceWith();
    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed).toEqual([]);
  });

  it('never lets a cross-tenant document contribute to the list', async () => {
    const foreign = {
      id: 'document-foreign-00000000000000001',
      organizationId: OTHER_ORG,
      projectId: PROJECT,
      title: 'Someone else’s document',
      body: 'not yours',
      createdByUserId: 'user-other-00000000000000000002',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as DocumentRow;
    const { service } = serviceWith([foreign]);

    const listed = await service.list(context, member([PROJECT]), { projectId: PROJECT });
    expect(listed).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(OTHER_ORG);
  });

  it('hides a project’s documents from a non-member (relation filter)', async () => {
    const mine = {
      id: 'document-0000-0000-0000-000000000010',
      organizationId: ORG,
      projectId: PROJECT,
      title: 'Members only',
      body: 'internal',
      createdByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as DocumentRow;
    const { service } = serviceWith([mine]);

    // A member of no project sees nothing; an org-wide role sees it.
    expect(await service.list(context, member([]), { projectId: PROJECT })).toEqual([]);
    const asOwner = await service.list(context, member([], true), { projectId: PROJECT });
    expect(asOwner.map((d) => d.id)).toEqual([mine.id]);
  });

  it('reads a document back by id for a project member', async () => {
    const mine = {
      id: 'document-0000-0000-0000-000000000020',
      organizationId: ORG,
      projectId: PROJECT,
      title: 'Readable',
      body: 'the prose',
      createdByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as DocumentRow;
    const { service } = serviceWith([mine]);

    const found = await service.get(context, member([PROJECT]), mine.id);
    expect(found.id).toBe(mine.id);
    expect(found.body).toBe('the prose');
    expect(JSON.stringify(found)).not.toContain(ORG);
  });

  it('reads an unknown documentId as not-found (not 500), even for an org-wide role', async () => {
    // The Known trap (FAST-PROTOCOL): the read route names the document by id, and an org-wide
    // caller passes the relation check regardless — so the tenant-scoped resolve must be what
    // 404s an unknown id. The repository returns null (no such row), and the service must surface
    // 404 with no data, never a 500.
    const { service } = serviceWith();
    const error = await service
      .get(context, member([], true), 'document-0000-0000-0000-0000000000ff')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('reads a cross-tenant documentId as not-found, never forbidden (belt-and-braces)', async () => {
    // The real repository scopes the read to the tenant so a foreign row never arrives; the fake
    // hands it over anyway, and the service's `authorize()` guard must still 404 it — a 403 would
    // confirm the document exists in another tenant.
    const foreign = {
      id: 'document-foreign-00000000000000009',
      organizationId: OTHER_ORG,
      projectId: PROJECT,
      title: 'Elsewhere',
      body: 'not yours',
      createdByUserId: 'user-other-00000000000000000009',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as DocumentRow;
    const { service } = serviceWith([foreign]);

    const error = await service
      .get(context, member([], true), foreign.id)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('refuses a create into a project the caller is not a member of, as not-found', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([]), { projectId: PROJECT, title: 'Sneaky', body: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    // Nothing was written.
    expect(store).toHaveLength(0);
  });

  it('refuses a create naming a project that does not exist as not-found (not 500), even for an org-wide role', async () => {
    // An org-wide role passes the relation check regardless of the project, so without the
    // tenant-scoped project resolution this would fall through to the composite foreign key and
    // surface as a 500 — the x90/x92 defect. `MISSING_PROJECT` is not `PROJECT`, so the fake
    // project lookup returns null and the service must 404 before any insert.
    const MISSING_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
    const { service, store } = serviceWith();
    const error = await service
      .create(context, member([], true), { projectId: MISSING_PROJECT, title: 'Ghost', body: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    // Nothing was written — the resolution ran before the transaction.
    expect(store).toHaveLength(0);
  });
});
