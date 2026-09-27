import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import {
  DocumentReadStateController,
  MyDocReadStateController,
} from './doc-read-state.controller.js';
import { DocReadStateService } from './doc-read-state.service.js';
import type { DocReadStateRepository } from './doc-read-state.repository.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocReadStateRow, DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * DOC read state (x297) controller/service proofs over the module's fakes, with the **real** `authorize`.
 * The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the chain owns it);
 * here the subject is the logic: mark read/unread self and read own batch, a repeated mark-read is
 * idempotent (one row, refreshed), the Known-trap cross-tenant 404 (no write), the authorize refusal
 * (a non-member is not-found, never forbidden), and a batch never returns another membership's rows.
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

/** A controller pair whose document lookup is scoped to `docOrg`; read state lives in an in-memory store. */
function controllersWith(docOrg = ORG): {
  doc: DocumentReadStateController;
  mine: MyDocReadStateController;
  store: DocReadStateRow[];
} {
  const store: DocReadStateRow[] = [];
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

  const readState = {
    markRead: async (
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
        existing.lastReadAt = new Date(Date.now() + ++seq);
        return existing;
      }
      const row = {
        id: `read-0000-0000-0000-0000000000${++seq}`,
        organizationId: ctx.organizationId,
        docId: input.docId,
        membershipId: input.membershipId,
        lastReadAt: new Date(),
      } as DocReadStateRow;
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
      if (index >= 0) store.splice(index, 1);
    },
    findForMemberByDocIds: async (
      _r: unknown,
      ctx: TenantContext,
      membershipId: string,
      docIds: readonly string[],
    ) =>
      store.filter(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.membershipId === membershipId &&
          docIds.includes(row.docId),
      ),
  } as unknown as DocReadStateRepository;

  const service = new DocReadStateService(database, documentsRepo, readState);
  return {
    doc: new DocumentReadStateController(service),
    mine: new MyDocReadStateController(service),
    store,
  };
}

describe('DocReadState', () => {
  it('marks read idempotently, batch-reads own, and never echoes the tenant id', async () => {
    const { doc, mine, store } = controllersWith();
    const caller = owner();

    const first = await doc.markRead(context, caller, DOC);
    const again = await doc.markRead(context, caller, DOC);
    expect(store).toHaveLength(1);
    expect(again.docId).toBe(first.docId);
    expect(first).not.toHaveProperty('organizationId');
    expect(first).not.toHaveProperty('membershipId');

    const batch = await mine.batch(context, caller, DOC);
    expect(batch.readStates.map((r) => r.docId)).toEqual([DOC]);
  });

  it('marks unread idempotently and drops the row', async () => {
    const { doc, mine, store } = controllersWith();
    const caller = owner();
    await doc.markRead(context, caller, DOC);
    await doc.markUnread(context, caller, DOC);
    expect(store).toHaveLength(0);
    // A second mark-unread is still success (no row → no-op), not a 404.
    await doc.markUnread(context, caller, DOC);
    const batch = await mine.batch(context, caller, DOC);
    expect(batch.readStates).toHaveLength(0);
  });

  it('does not return another membership’s read state in a batch', async () => {
    const { doc, mine } = controllersWith();
    await doc.markRead(context, owner(), DOC);
    const otherContext = {
      organizationId: ORG,
      userId: 'user-0000-0000-0000-0000-000000000002',
      membershipId: 'membership-0000-0000-000000000002',
    } as unknown as TenantContext;
    const otherCaller: Principal = {
      ...owner(),
      membershipId: 'membership-0000-0000-000000000002',
    };
    const batch = await mine.batch(otherContext, otherCaller, DOC);
    expect(batch.readStates).toHaveLength(0);
  });

  it('reads a cross-tenant document id as not-found (404) and writes nothing', async () => {
    const { doc, store } = controllersWith(OTHER_ORG);
    const error = await doc.markRead(context, owner(), DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies a non-member without project scope (masked 404) and writes nothing', async () => {
    // The document lives in a project the caller does not belong to and they have no org-wide scope, so
    // the real `authorize` denies `work.read`. The service masks the denial as not-found, never 403.
    const { doc, store } = controllersWith();
    const stranger: Principal = {
      ...owner(),
      role: 'member',
      hasOrgWideScope: false,
      projectIds: [],
    };
    const error = await doc.markRead(context, stranger, DOC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});
