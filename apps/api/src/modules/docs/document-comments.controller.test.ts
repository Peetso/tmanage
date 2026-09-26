import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocumentCommentsService } from './document-comments.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocumentCommentsRepository } from './document-comments.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentCommentRow, DocumentRow } from '../../common/database/schema.js';

/**
 * Docs "collaboration later" (x132) service proofs, database-free over the module's fakes and the
 * *real* `authorize()`. The migration and the tenant-scoped SQL round-trip belong to the DB suite
 * the chain owns; here the subject is the service's own permission logic — add-then-list for a
 * member, the Known-trap 404 (no write) for an unknown/cross-tenant document even for an org-wide
 * role, and the relation gate that denies a non-member and lists nothing.
 *
 * The fake `list`/`findById` deliberately do **not** apply the tenant scope the real SQL applies, so
 * a cross-tenant row reaches the service and its `authorize()` guard must drop it — belt-and-braces.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-000000000001';
const DOCUMENT = 'document-0000-0000-0000-000000000042';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = {
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

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

/** A service over in-memory stores whose reads omit the tenant scope on purpose. */
function serviceWith(documents: readonly DocumentRow[] = []): {
  service: DocumentCommentsService;
  commentStore: DocumentCommentRow[];
} {
  const docStore: DocumentRow[] = [...documents];
  const commentStore: DocumentCommentRow[] = [];
  let seq = 0;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  // Deliberately unscoped: a cross-tenant document reaches the service so its `authorize()` guard
  // must drop it, and an unknown id simply is not in the store.
  const docRepo = {
    findById: async (_runner: unknown, _ctx: unknown, documentId: string) =>
      docStore.find((row) => row.id === documentId) ?? null,
  } as unknown as DocumentsRepository;

  const commentRepo = {
    list: async (_runner: unknown, ctx: TenantContext, documentId: string) =>
      commentStore
        .filter((row) => row.organizationId === ctx.organizationId && row.documentId === documentId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    append: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly documentId: string;
        readonly body: string;
        readonly authorMembershipId: string;
      },
    ) => {
      const row = {
        id: `doccmt-0000-0000-0000-00000000${++seq}`,
        organizationId: ctx.organizationId,
        documentId: input.documentId,
        authorMembershipId: input.authorMembershipId,
        body: input.body,
        createdAt: new Date(),
      } as DocumentCommentRow;
      commentStore.push(row);
      return row;
    },
  } as unknown as DocumentCommentsRepository;

  return {
    service: new DocumentCommentsService(database, docRepo, commentRepo),
    commentStore,
  };
}

describe('DocumentCommentsService', () => {
  it('adds a comment, then lists it back oldest-first for a project member', async () => {
    const { service } = serviceWith([seededDocument()]);
    const caller = member([PROJECT]);

    const first = await service.add(context, caller, DOCUMENT, 'first comment');
    expect(first.documentId).toBe(DOCUMENT);
    expect(first.authorMembershipId).toBe(MEMBERSHIP);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(first)).not.toContain(ORG);

    await service.add(context, caller, DOCUMENT, 'second comment');
    const listed = await service.list(context, caller, DOCUMENT);
    expect(listed.map((c) => c.body)).toEqual(['first comment', 'second comment']);
  });

  it('refuses add/list on an unknown or cross-tenant documentId as 404, no write, even for an org-wide role', async () => {
    // The Known trap: an org-wide role passes the relation check regardless, so the tenant-scoped
    // resolve must 404 the id first. Unknown (empty store) and cross-tenant (OTHER_ORG) both apply.
    const unknown = serviceWith();
    const addError = await unknown.service
      .add(context, member([], true), DOCUMENT, 'sneaky')
      .catch((caught: unknown) => caught);
    expect(addError).toBeInstanceOf(ApiError);
    expect((addError as ApiError).status).toBe(404);
    expect(unknown.commentStore).toHaveLength(0);

    const foreign = serviceWith([seededDocument(OTHER_ORG)]);
    const listError = await foreign.service
      .list(context, member([PROJECT], true), DOCUMENT)
      .catch((caught: unknown) => caught);
    expect((listError as ApiError).status).toBe(404);
  });

  it('denies a non-member the write and list relation, and appends nothing', async () => {
    const { service, commentStore } = serviceWith([seededDocument()]);
    const nonMember = member([]);

    const addError = await service
      .add(context, nonMember, DOCUMENT, 'sneaky')
      .catch((caught: unknown) => caught);
    expect((addError as ApiError).status).toBe(404);

    const listError = await service
      .list(context, nonMember, DOCUMENT)
      .catch((caught: unknown) => caught);
    expect((listError as ApiError).status).toBe(404);

    expect(commentStore).toHaveLength(0);
  });
});
