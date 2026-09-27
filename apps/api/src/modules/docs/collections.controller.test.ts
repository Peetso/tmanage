import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocCollectionsController } from './collections.controller.js';
import { DocCollectionsService } from './collections.service.js';
import { DocCollectionsRepository } from './collections.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocCollectionRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * DOC collections (x264) controller/service proofs over the module's fakes, with the **real**
 * `authorize`. The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the chain
 * owns it); here the subject is the logic: create + dup-name 409, add/remove a document, the mandatory
 * refusal — adding a cross-tenant document is not-found (404) and writes nothing — and the member list
 * projecting only documents the caller can still read.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const COLLECTION = 'collection-0000-0000-0000-00000000001';
const DOC = 'document-0000-0000-0000-0000-00000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-000000000001';

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = {
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/** A controller whose document lookup is scoped to `docOrg`; collections and members live in memory. */
function controllerWith(docOrg = ORG): {
  ctl: DocCollectionsController;
  store: DocCollectionRow[];
} {
  const store: DocCollectionRow[] = [
    {
      id: COLLECTION,
      organizationId: ORG,
      collectionId: null,
      documentId: null,
      name: 'Handbook',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    } as DocCollectionRow,
  ];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const documentsRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      id === DOC && docOrg === ctx.organizationId
        ? ({
            id: DOC,
            organizationId: ctx.organizationId,
            projectId: PROJECT,
            title: 'Onboarding',
          } as DocumentRow)
        : null,
  } as unknown as DocumentsRepository;

  const repo = new DocCollectionsRepository();
  // Route the repository at the in-memory store (the SQL itself is the DB suite's job).
  repo.findCollection = async (_r, ctx, id) =>
    store.find(
      (r) => r.organizationId === ctx.organizationId && r.id === id && r.collectionId === null,
    ) ?? null;
  repo.createCollection = async (_r, ctx, name) => {
    if (store.some((r) => r.collectionId === null && r.name === name)) {
      const { DocCollectionNameConflictError } = await import('./collections.repository.js');
      throw new DocCollectionNameConflictError(name);
    }
    const row = {
      id: `collection-0000-0000-0000-0000000000${++seq}`,
      organizationId: ctx.organizationId,
      collectionId: null,
      documentId: null,
      name,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    } as DocCollectionRow;
    store.push(row);
    return row;
  };
  repo.findMember = async (_r, ctx, collectionId, documentId) =>
    store.find(
      (r) =>
        r.organizationId === ctx.organizationId &&
        r.collectionId === collectionId &&
        r.documentId === documentId,
    ) ?? null;
  repo.addMember = async (_r, ctx, collectionId, documentId) => {
    const existing = store.find(
      (r) => r.collectionId === collectionId && r.documentId === documentId,
    );
    if (existing) return existing;
    const row = {
      id: `member-0000-0000-0000-00000000000${++seq}`,
      organizationId: ctx.organizationId,
      collectionId,
      documentId,
      name: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    } as DocCollectionRow;
    store.push(row);
    return row;
  };
  repo.removeMember = async (_r, _ctx, collectionId, documentId) => {
    const i = store.findIndex(
      (r) => r.collectionId === collectionId && r.documentId === documentId,
    );
    if (i >= 0) store.splice(i, 1);
  };
  repo.listMembers = async (_r, ctx, collectionId) =>
    store
      .filter((r) => r.organizationId === ctx.organizationId && r.collectionId === collectionId)
      .map((r) => ({
        id: r.id,
        documentId: r.documentId as string,
        title: 'Onboarding',
        projectId: PROJECT,
        createdAt: r.createdAt,
      }));

  const service = new DocCollectionsService(database, repo, documentsRepo);
  return { ctl: new DocCollectionsController(service), store };
}

describe('DocCollections', () => {
  it('creates a collection, rejects a duplicate name (409), and never echoes the tenant id', async () => {
    const { ctl } = controllerWith();
    const created = await ctl.create(context, owner(), { name: 'Runbooks' });
    expect(created.name).toBe('Runbooks');
    expect(created).not.toHaveProperty('organizationId');
    const dup = await ctl.create(context, owner(), { name: 'Runbooks' }).catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(ApiError);
    expect((dup as ApiError).status).toBe(409);
  });

  it('adds a document idempotently and removes it', async () => {
    const { ctl, store } = controllerWith();
    const before = store.length;
    const first = await ctl.addDocument(context, owner(), COLLECTION, DOC);
    const again = await ctl.addDocument(context, owner(), COLLECTION, DOC);
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(before + 1);
    await ctl.removeDocument(context, owner(), COLLECTION, DOC);
    expect(store).toHaveLength(before);
  });

  it('lists a collection’s member documents', async () => {
    const { ctl } = controllerWith();
    await ctl.addDocument(context, owner(), COLLECTION, DOC);
    const { documents } = await ctl.documents(context, owner(), COLLECTION);
    expect(documents.map((d) => d.documentId)).toEqual([DOC]);
  });

  it('reads a cross-tenant document id as not-found (404) and writes nothing (the refusal)', async () => {
    const { ctl, store } = controllerWith('organization-0000-0000-0000-000000000002');
    const before = store.length;
    const error = await ctl.addDocument(context, owner(), COLLECTION, DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(before);
  });

  it('denies a suspended membership (403, the authorize boundary) and writes nothing', async () => {
    const { ctl, store } = controllerWith();
    const before = store.length;
    const suspended: Principal = { ...owner(), membershipStatus: 'suspended' };
    const error = await ctl
      .addDocument(context, suspended, COLLECTION, DOC)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(store).toHaveLength(before);
  });
});
