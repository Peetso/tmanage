import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import {
  DocumentSubscriptionController,
  MySubscriptionsController,
} from './subscriptions.controller.js';
import { DocSubscriptionsService } from './subscriptions.service.js';
import type {
  DocSubscriptionsRepository,
  SubscribedDocumentRow,
} from './subscriptions.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocSubscriptionRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * DOC subscriptions (x312) controller/service proofs over the module's fakes, with the **real**
 * `authorize`. The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the chain
 * owns it); here the subject is the logic and the refusals the brief mandates: follow/unfollow self and
 * list own, a duplicate PUT is idempotent, the Known-trap cross-tenant 404 (no write), and the authorize
 * refusal (a non-member without doc/work.read is not-found, never forbidden — the reason the service
 * masks it, and no row is written). The coarse `doc.read` gate itself is the `RequireCapability` guard's
 * job, integration-tested by the chain; this file proves the object-level scope the service adds.
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

/** A controller pair whose document lookup is scoped to `docOrg`; subscriptions live in an in-memory store. */
function controllersWith(docOrg = ORG): {
  doc: DocumentSubscriptionController;
  mine: MySubscriptionsController;
  store: DocSubscriptionRow[];
} {
  const store: DocSubscriptionRow[] = [];
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

  const subscriptions = {
    find: async (_r: unknown, ctx: TenantContext, documentId: string, membershipId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.documentId === documentId &&
          row.membershipId === membershipId,
      ) ?? null,
    add: async (
      _r: unknown,
      ctx: TenantContext,
      input: { documentId: string; membershipId: string },
    ) => {
      const existing = store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.documentId === input.documentId &&
          row.membershipId === input.membershipId,
      );
      if (existing) {
        return existing;
      }
      const row = {
        id: `subscription-0000-0000-0000-00000000${++seq}`,
        organizationId: ctx.organizationId,
        documentId: input.documentId,
        membershipId: input.membershipId,
        createdAt: new Date(),
      } as DocSubscriptionRow;
      store.push(row);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, documentId: string, membershipId: string) => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.documentId === documentId &&
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
    ): Promise<readonly SubscribedDocumentRow[]> =>
      store
        .filter(
          (row) => row.organizationId === ctx.organizationId && row.membershipId === membershipId,
        )
        .sort((a, b) => b.id.localeCompare(a.id))
        .map((row) => ({
          id: row.id,
          documentId: row.documentId,
          title: 'Design brief',
          projectId: PROJECT,
          createdAt: row.createdAt,
        })),
  } as unknown as DocSubscriptionsRepository;

  const service = new DocSubscriptionsService(database, documentsRepo, subscriptions);
  return {
    doc: new DocumentSubscriptionController(service),
    mine: new MySubscriptionsController(service),
    store,
  };
}

describe('DocSubscriptions', () => {
  it('follows self idempotently, reports status, lists own, and never echoes the tenant id', async () => {
    const { doc, mine, store } = controllersWith();
    const caller = owner();

    const first = await doc.subscribe(context, caller, DOC);
    const again = await doc.subscribe(context, caller, DOC);
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(1);
    expect(first).not.toHaveProperty('organizationId');
    expect(first).not.toHaveProperty('membershipId');

    expect(await doc.status(context, caller, DOC)).toEqual({ subscribed: true });

    const listed = await mine.list(context, caller);
    expect(listed.subscriptions.map((s) => s.documentId)).toEqual([DOC]);
    expect(listed.subscriptions[0]?.title).toBe('Design brief');
  });

  it('unfollows self idempotently', async () => {
    const { doc, store } = controllersWith();
    const caller = owner();
    await doc.subscribe(context, caller, DOC);
    await doc.unsubscribe(context, caller, DOC);
    expect(store).toHaveLength(0);
    // A second unsubscribe is still success (no row → no-op), not a 404.
    await doc.unsubscribe(context, caller, DOC);
    expect(await doc.status(context, caller, DOC)).toEqual({ subscribed: false });
  });

  it('does not list another membership’s subscriptions', async () => {
    const { doc, mine } = controllersWith();
    await doc.subscribe(context, owner(), DOC);
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
    expect(listed.subscriptions).toHaveLength(0);
  });

  it('reads a cross-tenant document id as not-found (404) and writes nothing', async () => {
    const { doc, store } = controllersWith(OTHER_ORG);
    const error = await doc.subscribe(context, owner(), DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies a non-member without project scope (masked 404) and writes nothing', async () => {
    // The document lives in a project the caller does not belong to and they have no org-wide scope, so
    // the real `authorize` denies `work.read` (the ceiling-mirror of `doc.read`). The service masks the
    // denial as not-found, never 403: a 403 would confirm the document exists, which a non-member must
    // not be able to probe. No subscription row is written.
    const { doc, store } = controllersWith();
    const stranger: Principal = {
      ...owner(),
      role: 'member',
      hasOrgWideScope: false,
      projectIds: [],
    };
    const error = await doc.subscribe(context, stranger, DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});
