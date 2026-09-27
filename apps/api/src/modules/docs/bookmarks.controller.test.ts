import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocumentBookmarkController, MyBookmarksController } from './bookmarks.controller.js';
import { DocBookmarksService } from './bookmarks.service.js';
import type { BookmarkedDocumentRow, DocBookmarksRepository } from './bookmarks.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocBookmarkRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * DOC bookmarks / favorites (x242) controller/service proofs over the module's fakes, with the **real**
 * `authorize`. The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the chain
 * owns it); here the subject is the logic: bookmark/unbookmark self and list own, a duplicate PUT is
 * idempotent, the Known-trap cross-tenant 404 (no write), and the authorize refusal (a non-member is
 * not-found, never forbidden — the reason the service masks it).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
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

/** A controller pair whose document lookup is scoped to `docOrg`; the bookmarks live in an in-memory store. */
function controllersWith(docOrg = ORG): {
  doc: DocumentBookmarkController;
  mine: MyBookmarksController;
  store: DocBookmarkRow[];
} {
  const store: DocBookmarkRow[] = [];
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
            title: 'Design brief',
          } as DocumentRow)
        : null,
  } as unknown as DocumentsRepository;

  const bookmarks = {
    find: async (_r: unknown, ctx: TenantContext, docId: string, membershipId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.docId === docId &&
          row.membershipId === membershipId,
      ) ?? null,
    add: async (
      _r: unknown,
      ctx: TenantContext,
      input: { docId: string; membershipId: string },
    ) => {
      const existing = store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.docId === input.docId &&
          row.membershipId === input.membershipId,
      );
      if (existing) {
        return existing;
      }
      const row = {
        id: `bookmark-0000-0000-0000-0000000000${++seq}`,
        organizationId: ctx.organizationId,
        docId: input.docId,
        membershipId: input.membershipId,
        createdAt: new Date(),
      } as DocBookmarkRow;
      store.push(row);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, docId: string, membershipId: string) => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.docId === docId &&
          row.membershipId === membershipId,
      );
      if (index >= 0) {
        store.splice(index, 1);
      }
    },
    listForMember: async (
      _r: unknown,
      ctx: TenantContext,
      membershipId: string,
    ): Promise<readonly BookmarkedDocumentRow[]> =>
      store
        .filter(
          (row) => row.organizationId === ctx.organizationId && row.membershipId === membershipId,
        )
        .sort((a, b) => b.id.localeCompare(a.id))
        .map((row) => ({
          id: row.id,
          docId: row.docId,
          title: 'Design brief',
          projectId: PROJECT,
          createdAt: row.createdAt,
        })),
  } as unknown as DocBookmarksRepository;

  const service = new DocBookmarksService(database, documentsRepo, bookmarks);
  return {
    doc: new DocumentBookmarkController(service),
    mine: new MyBookmarksController(service),
    store,
  };
}

describe('DocBookmarks', () => {
  it('bookmarks self idempotently, reports status, lists own, and never echoes the tenant id', async () => {
    const { doc, mine, store } = controllersWith();
    const caller = owner();

    const first = await doc.add(context, caller, DOC);
    const again = await doc.add(context, caller, DOC);
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(1);
    expect(first).not.toHaveProperty('organizationId');
    expect(first).not.toHaveProperty('membershipId');

    expect(await doc.status(context, caller, DOC)).toEqual({ bookmarked: true });

    const listed = await mine.list(context, caller);
    expect(listed.bookmarks.map((b) => b.docId)).toEqual([DOC]);
    expect(listed.bookmarks[0]?.title).toBe('Design brief');
  });

  it('unbookmarks self idempotently', async () => {
    const { doc, store } = controllersWith();
    const caller = owner();
    await doc.add(context, caller, DOC);
    await doc.remove(context, caller, DOC);
    expect(store).toHaveLength(0);
    // A second unbookmark is still success (no row → no-op), not a 404.
    await doc.remove(context, caller, DOC);
    expect(await doc.status(context, caller, DOC)).toEqual({ bookmarked: false });
  });

  it('does not list another membership’s bookmarks', async () => {
    const { doc, mine } = controllersWith();
    await doc.add(context, owner(), DOC);
    const otherContext = {
      organizationId: ORG,
      userId: 'user-0000-0000-0000-0000-000000000002',
      membershipId: 'membership-0000-0000-000000000002',
    } as unknown as TenantContext;
    const otherCaller: Principal = {
      ...owner(),
      membershipId: 'membership-0000-0000-000000000002',
    };
    const listed = await mine.list(otherContext, otherCaller);
    expect(listed.bookmarks).toHaveLength(0);
  });

  it('reads a cross-tenant document id as not-found (404) and writes nothing', async () => {
    const { doc, store } = controllersWith(OTHER_ORG);
    const error = await doc.add(context, owner(), DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies a non-member without project scope (masked 404) and writes nothing', async () => {
    // The document lives in a project the caller does not belong to and they have no org-wide scope, so
    // the real `authorize` denies `work.read`. The service masks the denial as not-found, never 403: a
    // 403 would confirm the document exists, which a non-member must not be able to probe.
    const { doc, store } = controllersWith();
    const stranger: Principal = {
      ...owner(),
      role: 'member',
      hasOrgWideScope: false,
      projectIds: [],
    };
    const error = await doc.add(context, stranger, DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});
