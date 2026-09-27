import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocTagsController } from './doc-tags.controller.js';
import { DocTagsService } from './doc-tags.service.js';
import type { DocTagsRepository } from './doc-tags.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocTagRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x269 document tags controller/service proofs over the module's fakes, with the **real** `authorize`.
 * The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the chain owns it);
 * here the subject is the logic: define + duplicate-name 409, idempotent assign, and — the required
 * refusal — assigning a tag to a document in another tenant is a 404 with no insert.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const DOC = 'document-0000-0000-0000-0000-00000000001';
const TAG = 'doctag-0000-0000-0000-0000-0000000000t1';

function owner(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
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

const context = { organizationId: ORG } as unknown as TenantContext;

/** A controller whose document lookup is scoped to `docOrg`; tags live in an in-memory store. */
function controllerWith(docOrg = ORG): { ctrl: DocTagsController; store: DocTagRow[] } {
  const store: DocTagRow[] = [];
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

  const def = (over: Partial<DocTagRow>): DocTagRow =>
    ({
      id: `doctag-0000-0000-0000-0000-00000000${++seq}`,
      organizationId: ORG,
      documentId: null,
      tagId: null,
      name: null,
      createdAt: new Date(),
      ...over,
    }) as DocTagRow;

  const tags = {
    listDefinitions: async (_r: unknown, _ctx: TenantContext) =>
      store.filter((row) => row.documentId === null),
    findDefinition: async (_r: unknown, _ctx: TenantContext, tagId: string) =>
      store.find((row) => row.id === tagId && row.documentId === null) ?? null,
    findDefinitionByName: async (_r: unknown, _ctx: TenantContext, name: string) =>
      store.find((row) => row.documentId === null && row.name === name) ?? null,
    createDefinition: async (_r: unknown, _ctx: TenantContext, name: string) => {
      const row = def({ name });
      store.push(row);
      return row;
    },
    listAssignments: async (_r: unknown, _ctx: TenantContext, documentId: string) =>
      store.filter((row) => row.documentId === documentId),
    findAssignment: async (_r: unknown, _ctx: TenantContext, documentId: string, tagId: string) =>
      store.find((row) => row.documentId === documentId && row.tagId === tagId) ?? null,
    createAssignment: async (
      _r: unknown,
      _ctx: TenantContext,
      documentId: string,
      tagId: string,
    ) => {
      const row = def({ documentId, tagId, name: null });
      store.push(row);
      return row;
    },
    deleteAssignment: async (
      _r: unknown,
      _ctx: TenantContext,
      documentId: string,
      tagId: string,
    ) => {
      const i = store.findIndex((row) => row.documentId === documentId && row.tagId === tagId);
      if (i >= 0) store.splice(i, 1);
      return i >= 0;
    },
  } as unknown as DocTagsRepository;

  const service = new DocTagsService(database, documentsRepo, tags);
  return { ctrl: new DocTagsController(service), store };
}

describe('DocTags', () => {
  it('defines a tag, rejects a duplicate name (409), and never echoes the tenant id', async () => {
    const { ctrl } = controllerWith();
    const created = await ctrl.define(context, { name: 'Runbook' });
    expect(created.name).toBe('Runbook');
    expect(created).not.toHaveProperty('organizationId');
    const clash = await ctrl.define(context, { name: 'Runbook' }).catch((e: unknown) => e);
    expect((clash as ApiError).status).toBe(409);
  });

  it('assigns idempotently and unassigns', async () => {
    const { ctrl, store } = controllerWith();
    const tag = await ctrl.define(context, { name: 'Runbook' });
    const first = await ctrl.assign(context, owner(), DOC, tag.id);
    const again = await ctrl.assign(context, owner(), DOC, tag.id);
    expect(again.id).toBe(first.id);
    expect(store.filter((r) => r.documentId === DOC)).toHaveLength(1);
    const listed = await ctrl.listForDocument(context, owner(), DOC);
    expect(listed.tags.map((t) => t.name)).toEqual(['Runbook']);
    await ctrl.remove(context, owner(), DOC, tag.id);
    expect(store.filter((r) => r.documentId === DOC)).toHaveLength(0);
  });

  it('rejects an unknown tag id as not-found (404)', async () => {
    const { ctrl } = controllerWith();
    const error = await ctrl.assign(context, owner(), DOC, TAG).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
  });

  it('assigning a tag to a document in another tenant is 404 with no insert', async () => {
    // The document lives in another studio, so the tenant-scoped lookup does not resolve. The service
    // answers 404 before authorizing or writing — never a foreign-key 500, never a leak.
    const { ctrl, store } = controllerWith(OTHER_ORG);
    const tag = await ctrl.define(context, { name: 'Runbook' });
    const error = await ctrl.assign(context, owner(), DOC, tag.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store.filter((r) => r.documentId !== null)).toHaveLength(0);
  });
});
