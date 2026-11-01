import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocumentsService } from './documents.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocumentVersionsRepository } from './document-versions.repository.js';
import type { DocumentTemplatesRepository } from './document-templates.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  DocumentRow,
  DocumentTemplateRow,
  DocumentVersionRow,
} from '../../common/database/schema.js';

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
function serviceWith(
  seed: readonly DocumentRow[] = [],
  seedVersions: readonly DocumentVersionRow[] = [],
  seedTemplates: readonly DocumentTemplateRow[] = [],
): {
  service: DocumentsService;
  store: DocumentRow[];
  versionStore: DocumentVersionRow[];
  templateStore: DocumentTemplateRow[];
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

  // A versions store scoped by the acting tenant, mirroring the real repository's contract: append
  // assigns the next `version_no` for the document, list is newest-first, and a snapshot is found by
  // its number. The tenant scope is applied so a cross-tenant append/list cannot contribute.
  const versionStore: DocumentVersionRow[] = [...seedVersions];
  let versionSeq = versionStore.length;
  const versions = {
    list: async (_runner: unknown, ctx: TenantContext, documentId: string) =>
      versionStore
        .filter((row) => row.organizationId === ctx.organizationId && row.documentId === documentId)
        .sort((a, b) => b.versionNo - a.versionNo),
    findByVersionNo: async (
      _runner: unknown,
      ctx: TenantContext,
      documentId: string,
      versionNo: number,
    ) =>
      versionStore.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.documentId === documentId &&
          row.versionNo === versionNo,
      ) ?? null,
    append: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly documentId: string;
        readonly body: string;
        readonly bodyFormat?: string;
        readonly editedByUserId: string;
      },
    ) => {
      const versionNo =
        versionStore
          .filter(
            (row) =>
              row.organizationId === ctx.organizationId && row.documentId === input.documentId,
          )
          .reduce((max, row) => Math.max(max, row.versionNo), 0) + 1;
      const row = {
        id: `docver-0000-0000-0000-00000000${++versionSeq}`,
        organizationId: ctx.organizationId,
        documentId: input.documentId,
        versionNo,
        body: input.body,
        bodyFormat: input.bodyFormat ?? 'markdown',
        editedByUserId: input.editedByUserId,
        createdAt: new Date(),
      } as DocumentVersionRow;
      versionStore.push(row);
      // Bump the parent document's current body, as the real repository does in the same txn.
      const doc = store.find(
        (d) => d.id === input.documentId && d.organizationId === ctx.organizationId,
      );
      if (doc) (doc as { body: string }).body = input.body;
      return row;
    },
    latestVersionNo: async (_r: unknown, _c: unknown, id: string) =>
      versionStore.filter((row) => row.documentId === id).length,
  } as unknown as DocumentVersionsRepository;

  // A templates store scoped by the acting tenant, mirroring the real repository's contract:
  // create assigns an id, list is tenant-scoped, and findById returns null for a cross-tenant id
  // (exactly what the real scoped SELECT does), which is what applyTemplate turns into a 404.
  const templateStore: DocumentTemplateRow[] = [...seedTemplates];
  let templateSeq = templateStore.length;
  const templates = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      templateStore
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    findById: async (_runner: unknown, ctx: TenantContext, templateId: string) =>
      templateStore.find(
        (row) => row.id === templateId && row.organizationId === ctx.organizationId,
      ) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly name: string;
        readonly purpose: string;
        readonly body: string;
        readonly createdByUserId: string;
      },
    ) => {
      const row = {
        id: `doctpl-0000-0000-0000-00000000${++templateSeq}`,
        organizationId: ctx.organizationId,
        name: input.name,
        purpose: input.purpose,
        body: input.body,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
      } as DocumentTemplateRow;
      templateStore.push(row);
      return row;
    },
  } as unknown as DocumentTemplatesRepository;

  return {
    service: new DocumentsService(database, repository, projects, versions, templates),
    store,
    versionStore,
    templateStore,
  };
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

// ─────────────────────────────────────────────────────────────────────────────
// DOC-02/DOC-03 (x112) — versions: save, list, compare, restore.
// ─────────────────────────────────────────────────────────────────────────────

const DOCUMENT = 'document-0000-0000-0000-000000000042';

/** A seeded document in the acting tenant, so version methods have a parent to resolve. */
function seededDocument(organizationId = ORG): DocumentRow {
  return {
    id: DOCUMENT,
    organizationId,
    projectId: PROJECT,
    title: 'Kickoff brief',
    body: 'v0 body',
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as DocumentRow;
}

describe('DocumentsService versions (DOC-02/DOC-03)', () => {
  it('saves, lists, compares and restores — a round-trip for a project member', async () => {
    const { service, store, versionStore } = serviceWith([seededDocument()]);
    const caller = member([PROJECT]);

    const first = await service.saveVersion(context, caller, DOCUMENT, 'first save');
    expect(first.versionNo).toBe(1);
    expect(first.documentId).toBe(DOCUMENT);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(first)).not.toContain(ORG);
    // The parent document's current body was bumped in the same append.
    expect(store.find((d) => d.id === DOCUMENT)?.body).toBe('first save');

    const second = await service.saveVersion(context, caller, DOCUMENT, 'second save');
    expect(second.versionNo).toBe(2);

    // Listed newest-first.
    const listed = await service.listVersions(context, caller, DOCUMENT);
    expect(listed.map((v) => v.versionNo)).toEqual([2, 1]);

    // Compare reads one snapshot by number.
    const v1 = await service.getVersion(context, caller, DOCUMENT, 1);
    expect(v1.body).toBe('first save');

    // Restore is forward-append: a new version equal to v1, never a mutation of history.
    const restored = await service.restore(context, caller, DOCUMENT, 1);
    expect(restored.versionNo).toBe(3);
    expect(restored.body).toBe('first save');
    expect(store.find((d) => d.id === DOCUMENT)?.body).toBe('first save');
    // History is intact: three rows, versions 1..3, and v1/v2 are unchanged.
    expect(versionStore).toHaveLength(3);
    expect(versionStore.find((r: DocumentVersionRow) => r.versionNo === 1)?.body).toBe(
      'first save',
    );
    expect(versionStore.find((r: DocumentVersionRow) => r.versionNo === 2)?.body).toBe(
      'second save',
    );
  });

  it('refuses a save on an unknown/cross-tenant documentId as 404, no write (Known trap), even for an org-wide role', async () => {
    // An org-wide role passes the relation check regardless of the document, so without the
    // tenant-scoped resolution first this would reach the composite foreign key and surface as a
    // 500. The store is empty, so `findById` returns null and the service must 404 before any write.
    const { service, versionStore } = serviceWith();
    const error = await service
      .saveVersion(context, member([], true), DOCUMENT, 'body')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(versionStore).toHaveLength(0);
  });

  it('does not resolve a document that belongs to another tenant (404)', async () => {
    // The document exists, but in OTHER_ORG. The tenant-scoped resolution returns null for the
    // acting ORG context, so a caller in ORG gets 404 and nothing is written.
    const { service, versionStore } = serviceWith([seededDocument(OTHER_ORG)]);
    const error = await service
      .saveVersion(context, member([PROJECT], true), DOCUMENT, 'body')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(versionStore).toHaveLength(0);
  });

  it('denies a caller without the write relation on the project, and appends nothing', async () => {
    // The permission boundary this slice adds: a caller who may not write the document's project
    // (here a member of no project) is denied at the `work.create` relation check and no version is
    // appended — surfaced as 404, never 403, for the reason `get` gives.
    const { service, versionStore } = serviceWith(
      [seededDocument()],
      [
        {
          id: 'docver-seed-000000000000000000001',
          organizationId: ORG,
          documentId: DOCUMENT,
          versionNo: 1,
          body: 'existing',
          editedByUserId: USER,
          createdAt: new Date(),
        } as DocumentVersionRow,
      ],
    );
    // Seed one existing version so a successful restore would have grown the store.
    const nonMember = member([]);

    const saveError = await service
      .saveVersion(context, nonMember, DOCUMENT, 'sneaky')
      .catch((caught: unknown) => caught);
    expect(saveError).toBeInstanceOf(ApiError);
    expect((saveError as ApiError).status).toBe(404);

    const restoreError = await service
      .restore(context, nonMember, DOCUMENT, 1)
      .catch((caught: unknown) => caught);
    expect(restoreError).toBeInstanceOf(ApiError);
    expect((restoreError as ApiError).status).toBe(404);

    // Nothing appended by either denied call — still just the seeded version.
    expect(versionStore).toHaveLength(1);
  });

  it('returns 404 for a version number that does not exist (compare and restore)', async () => {
    const { service, versionStore } = serviceWith([seededDocument()]);
    const caller = member([PROJECT]);

    const getError = await service
      .getVersion(context, caller, DOCUMENT, 99)
      .catch((caught: unknown) => caught);
    expect((getError as ApiError).status).toBe(404);

    const restoreError = await service
      .restore(context, caller, DOCUMENT, 99)
      .catch((caught: unknown) => caught);
    expect((restoreError as ApiError).status).toBe(404);
    expect(versionStore).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DOC-04/ADM-06 (x119) — document templates: create, list, apply.
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE = 'doctpl-0000-0000-0000-000000000042';

/** A seeded template in the given tenant, so apply/list have something to resolve. */
function seededTemplate(organizationId = ORG): DocumentTemplateRow {
  return {
    id: TEMPLATE,
    organizationId,
    name: 'Kickoff template',
    purpose: 'Start a project kickoff brief',
    body: 'template body prose',
    createdByUserId: USER,
    createdAt: new Date(),
  } as DocumentTemplateRow;
}

describe('DocumentsService templates (DOC-04/ADM-06)', () => {
  it('creates a template, lists it, and applies it to a project — a round-trip', async () => {
    const { service, store, templateStore } = serviceWith();
    const caller = member([PROJECT]);

    const created = await service.createTemplate(context, caller, {
      name: 'Kickoff template',
      purpose: 'Start a project kickoff brief',
      body: 'template body prose',
    });
    expect(created.name).toBe('Kickoff template');
    expect(created.purpose).toBe('Start a project kickoff brief');
    expect(created.body).toBe('template body prose');
    expect(created.createdByUserId).toBe(USER);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await service.listTemplates(context, caller);
    expect(listed.map((t) => t.id)).toEqual([created.id]);

    // Apply seeds a NEW document from the template body; the template is not mutated.
    const applied = await service.applyTemplate(context, caller, created.id, {
      projectId: PROJECT,
    });
    expect(applied.projectId).toBe(PROJECT);
    expect(applied.title).toBe('Kickoff template');
    expect(applied.body).toBe('template body prose');
    expect(store.map((d) => d.id)).toEqual([applied.id]);
    // Template untouched: still one template, same body.
    expect(templateStore).toHaveLength(1);
    expect(templateStore[0]?.body).toBe('template body prose');
  });

  it('applies with an explicit title override, still seeded from the template body', async () => {
    const { service } = serviceWith([], [], [seededTemplate()]);
    const applied = await service.applyTemplate(context, member([PROJECT]), TEMPLATE, {
      projectId: PROJECT,
      title: 'Acme kickoff',
    });
    expect(applied.title).toBe('Acme kickoff');
    expect(applied.body).toBe('template body prose');
  });

  it('refuses apply of an unknown/cross-tenant templateId as 404, no write (Known trap), even for an org-wide role', async () => {
    // An org-wide role passes the relation check regardless, so without the tenant-scoped template
    // resolution this would reach the document create path and, for a cross-tenant/unknown id,
    // surface wrongly. The store is empty, so findById returns null and the service 404s first.
    const { service, store } = serviceWith();
    const error = await service
      .applyTemplate(context, member([PROJECT], true), TEMPLATE, { projectId: PROJECT })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('does not apply a template that belongs to another tenant (404)', async () => {
    // The template exists, but in OTHER_ORG. The tenant-scoped resolution returns null for the
    // acting ORG context, so a caller in ORG gets 404 and nothing is written.
    const { service, store } = serviceWith([], [], [seededTemplate(OTHER_ORG)]);
    const error = await service
      .applyTemplate(context, member([PROJECT], true), TEMPLATE, { projectId: PROJECT })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses apply naming an unknown project as 404 (not 500), reusing the document create boundary', async () => {
    const MISSING_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
    const { service, store } = serviceWith([], [], [seededTemplate()]);
    const error = await service
      .applyTemplate(context, member([], true), TEMPLATE, { projectId: MISSING_PROJECT })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses apply into a project the caller is not a member of, as not-found', async () => {
    const { service, store } = serviceWith([], [], [seededTemplate()]);
    const error = await service
      .applyTemplate(context, member([]), TEMPLATE, { projectId: PROJECT })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies template create and list to a suspended membership (authorize boundary), and writes nothing', async () => {
    // The permission boundary this slice adds: the org-scoped `work.create`/`work.read` authorize is
    // the authoritative decision behind the route guard. A suspended membership is denied here even
    // though the guard would have passed a live one — and nothing is written.
    const { service, templateStore } = serviceWith();
    const suspended = { ...member([], true), membershipStatus: 'suspended' as const };

    const createError = await service
      .createTemplate(context, suspended, { name: 'X', purpose: 'Y', body: 'Z' })
      .catch((caught: unknown) => caught);
    expect(createError).toBeInstanceOf(ApiError);
    expect((createError as ApiError).status).toBe(403);
    expect(templateStore).toHaveLength(0);

    const listError = await service
      .listTemplates(context, suspended)
      .catch((caught: unknown) => caught);
    expect((listError as ApiError).status).toBe(403);
  });
});

describe('DocumentsService.saveVersion R5 (format, conflict guard)', () => {
  it('stores html sanitised, keeps markdown as is, and refuses a stale expectedVersionNo', async () => {
    const { service } = serviceWith([seededDocument()]);
    const save = (body: string, options: object) =>
      service.saveVersion(context, member([PROJECT]), DOCUMENT, body, options);
    const html = await save('<p>a</p><script>x</script>', { format: 'html', orgSlug: 'acme' });
    expect([html.body, html.bodyFormat]).toEqual(['<p>a</p>', 'html']);
    expect((await save('# md', {})).bodyFormat).toBe('markdown');
    const stale = await save('late', { expectedVersionNo: 1 }).catch((caught: unknown) => caught);
    expect(stale).toMatchObject({ status: 409, details: [{ message: '2' }] });
  });
});
