import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { RevisionsController } from './revisions.controller.js';
import { RevisionsService } from './revisions.service.js';
import type { DocRevisionsRepository } from './revisions.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocRevisionRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * DOC revision history (x241) controller/service proofs over the module's fakes, with the **real**
 * `authorize`. The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the
 * chain owns it); here the subject is the logic: capture→list newest-first with a monotonic `rev_no`,
 * restore forward-appending a new revision, the Known-trap cross-tenant 404 (no write), and the
 * authorize refusal (a non-member is not-found, never forbidden — the reason the service masks it).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const DOC = 'document-0000-0000-0000-0000-00000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** A controller whose document lookup is scoped to `docOrg`; the revisions live in an in-memory store. */
function controllerWith(docOrg = ORG): {
  controller: RevisionsController;
  store: DocRevisionRow[];
} {
  const store: DocRevisionRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const documentsRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      id === DOC && docOrg === ctx.organizationId
        ? ({ id: DOC, organizationId: ctx.organizationId, projectId: PROJECT } as DocumentRow)
        : null,
  } as unknown as DocumentsRepository;

  const revisions = {
    list: async (_r: unknown, ctx: TenantContext, docId: string) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId && row.docId === docId)
        .sort((a, b) => b.revNo - a.revNo),
    findById: async (_r: unknown, ctx: TenantContext, docId: string, revisionId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId && row.docId === docId && row.id === revisionId,
      ) ?? null,
    append: async (
      _r: unknown,
      ctx: TenantContext,
      input: { docId: string; bodySnapshot: string; savedBy: string },
    ) => {
      const revNo =
        store
          .filter((row) => row.organizationId === ctx.organizationId && row.docId === input.docId)
          .reduce((max, row) => Math.max(max, row.revNo), 0) + 1;
      const row = {
        id: `revision-0000-0000-0000-0000000000${++seq}`,
        organizationId: ctx.organizationId,
        docId: input.docId,
        revNo,
        bodySnapshot: input.bodySnapshot,
        savedBy: input.savedBy,
        savedAt: new Date(),
      } as DocRevisionRow;
      store.push(row);
      return row;
    },
  } as unknown as DocRevisionsRepository;

  const service = new RevisionsService(database, documentsRepo, revisions);
  return { controller: new RevisionsController(service), store };
}

describe('RevisionsController', () => {
  it('captures, lists newest-first with a monotonic rev_no, and never echoes the tenant id', async () => {
    const { controller } = controllerWith();
    const caller = owner();
    await controller.capture(context, caller, DOC, { bodySnapshot: 'v1' });
    await controller.capture(context, caller, DOC, { bodySnapshot: 'v2' });

    const listed = await controller.list(context, caller, DOC);
    expect(listed.revisions.map((r) => r.revNo)).toEqual([2, 1]);
    expect(listed.revisions.map((r) => r.bodySnapshot)).toEqual(['v2', 'v1']);
    expect(listed.revisions[0]).not.toHaveProperty('organizationId');
  });

  it('restores a prior revision by forward-appending a new revision', async () => {
    const { controller, store } = controllerWith();
    const caller = owner();
    const first = await controller.capture(context, caller, DOC, { bodySnapshot: 'v1' });
    await controller.capture(context, caller, DOC, { bodySnapshot: 'v2' });

    const restored = await controller.restore(context, caller, DOC, first.id);
    expect(restored.revNo).toBe(3);
    expect(restored.bodySnapshot).toBe('v1');
    expect(store).toHaveLength(3);
  });

  it('reads a cross-tenant document id as not-found (404) and writes nothing', async () => {
    const { controller, store } = controllerWith(OTHER_ORG);
    const error = await controller
      .capture(context, owner(), DOC, { bodySnapshot: 'v1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies capture to a non-member without project scope (masked 404) and writes nothing', async () => {
    // The document lives in a project the caller does not belong to and they have no org-wide scope,
    // so the real `authorize` denies. The service masks the denial as not-found, never 403: a 403
    // would confirm the document exists, which a non-member must not be able to probe.
    const { controller, store } = controllerWith();
    const stranger: Principal = {
      ...owner(),
      role: 'member',
      hasOrgWideScope: false,
      projectIds: [],
    };
    const error = await controller
      .capture(context, stranger, DOC, { bodySnapshot: 'v1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});
