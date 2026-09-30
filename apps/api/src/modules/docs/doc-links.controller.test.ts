import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { DocBacklinksController, DocLinksController } from './doc-links.controller.js';
import { DocLinksService } from './doc-links.service.js';
import type { DocLinksRepository, LinkedDocumentRow } from './doc-links.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocLinkRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * DOC links + backlinks (x296) controller/service proofs over the module's fakes, with the **real**
 * `authorize`. The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the chain
 * owns it); here the subject is the logic: link/unlink and list outgoing + backlinks, an idempotent
 * repeated create, the mandated refusals — a self-link is a 400 with no insert, a cross-tenant target
 * is a 404 with no insert (no existence leak), and a non-member is not-found (never forbidden) — plus
 * that the write routes require `doc.write` and the reads `doc.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const DOC_A = 'document-0000-0000-0000-0000-0000000000a1';
const DOC_B = 'document-0000-0000-0000-0000-0000000000b2';
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

/** Controllers whose document lookup is scoped to `docOrg`; the links live in an in-memory store. */
function controllersWith(docOrg = ORG): {
  links: DocLinksController;
  backlinks: DocBacklinksController;
  store: DocLinkRow[];
} {
  const store: DocLinkRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const known = new Set([DOC_A, DOC_B]);
  const documentsRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      known.has(id) && docOrg === ctx.organizationId
        ? ({
            id,
            organizationId: ctx.organizationId,
            projectId: PROJECT,
            title: `Doc ${id.slice(-2)}`,
          } as DocumentRow)
        : null,
  } as unknown as DocumentsRepository;

  const repo = {
    find: async (_r: unknown, ctx: TenantContext, source: string, target: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.sourceDocId === source &&
          row.targetDocId === target,
      ) ?? null,
    add: async (
      _r: unknown,
      ctx: TenantContext,
      input: { sourceDocId: string; targetDocId: string; createdByUserId: string },
    ) => {
      const existing = store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.sourceDocId === input.sourceDocId &&
          row.targetDocId === input.targetDocId,
      );
      if (existing) return existing;
      const row = {
        id: `link-0000-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        sourceDocId: input.sourceDocId,
        targetDocId: input.targetDocId,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
      } as DocLinkRow;
      store.push(row);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, source: string, target: string) => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.sourceDocId === source &&
          row.targetDocId === target,
      );
      if (index >= 0) store.splice(index, 1);
    },
    listOutgoing: async (
      _r: unknown,
      ctx: TenantContext,
      source: string,
    ): Promise<readonly LinkedDocumentRow[]> =>
      store
        .filter((row) => row.organizationId === ctx.organizationId && row.sourceDocId === source)
        .map((row) => ({
          id: row.id,
          docId: row.targetDocId,
          title: `Doc ${row.targetDocId.slice(-2)}`,
          projectId: PROJECT,
          createdAt: row.createdAt,
        })),
    listBacklinks: async (
      _r: unknown,
      ctx: TenantContext,
      target: string,
    ): Promise<readonly LinkedDocumentRow[]> =>
      store
        .filter((row) => row.organizationId === ctx.organizationId && row.targetDocId === target)
        .map((row) => ({
          id: row.id,
          docId: row.sourceDocId,
          title: `Doc ${row.sourceDocId.slice(-2)}`,
          projectId: PROJECT,
          createdAt: row.createdAt,
        })),
  } as unknown as DocLinksRepository;

  const service = new DocLinksService(database, documentsRepo, repo);
  return {
    links: new DocLinksController(service),
    backlinks: new DocBacklinksController(service),
    store,
  };
}

describe('DocLinks', () => {
  it('links idempotently, lists outgoing + backlinks, and never echoes the tenant id', async () => {
    const { links, backlinks, store } = controllersWith();
    const caller = owner();

    const first = await links.add(context, caller, DOC_A, { targetDocId: DOC_B });
    const again = await links.add(context, caller, DOC_A, { targetDocId: DOC_B });
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(1);
    expect(first).not.toHaveProperty('organizationId');
    expect(first.docId).toBe(DOC_B);

    const outgoing = await links.list(context, caller, DOC_A);
    expect(outgoing.links.map((l) => l.docId)).toEqual([DOC_B]);

    const incoming = await backlinks.list(context, caller, DOC_B);
    expect(incoming.backlinks.map((l) => l.docId)).toEqual([DOC_A]);
  });

  it('unlinks idempotently (no link → still 204)', async () => {
    const { links, store } = controllersWith();
    const caller = owner();
    await links.add(context, caller, DOC_A, { targetDocId: DOC_B });
    await links.remove(context, caller, DOC_A, DOC_B);
    expect(store).toHaveLength(0);
    await expect(links.remove(context, caller, DOC_A, DOC_B)).resolves.toBeUndefined();
  });

  it('refuses a self-link with 400 and writes nothing', async () => {
    const { links, store } = controllersWith();
    const error = await links
      .add(context, owner(), DOC_A, { targetDocId: DOC_A })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it('reads a cross-tenant target as not-found (404) and writes nothing', async () => {
    // Both ends live in OTHER_ORG, so the acting tenant's document lookup returns null → 404.
    const { links, store } = controllersWith(OTHER_ORG);
    const error = await links
      .add(context, owner(), DOC_A, { targetDocId: DOC_B })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies a non-member without project scope (masked 404) and writes nothing', async () => {
    // The documents live in a project the caller does not belong to and they have no org-wide scope, so
    // the real `authorize` denies. The service masks the denial as not-found, never 403: a 403 would
    // confirm the document exists, which a non-member must not probe.
    const { links, store } = controllersWith();
    const stranger: Principal = {
      ...owner(),
      role: 'member',
      hasOrgWideScope: false,
      projectIds: [],
    };
    const error = await links
      .add(context, stranger, DOC_A, { targetDocId: DOC_B })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('requires an empty-body target (400)', async () => {
    const { links } = controllersWith();
    const error = await links.add(context, owner(), DOC_A, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
  });

  it('gates writes on doc.write and reads on doc.read', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, DocLinksController.prototype.add)).toBe(
      'doc.write',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, DocLinksController.prototype.remove)).toBe(
      'doc.write',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, DocLinksController.prototype.list)).toBe(
      'doc.read',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, DocBacklinksController.prototype.list)).toBe(
      'doc.read',
    );
  });
});
