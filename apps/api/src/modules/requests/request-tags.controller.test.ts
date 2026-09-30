import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { RequestTagsController } from './request-tags.controller.js';
import { RequestTagsService } from './request-tags.service.js';
import type { ClientRequestsRepository } from './client-requests.repository.js';
import type { RequestTagsRepository } from './request-tags.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestTagRow } from '../../common/database/schema.js';

/**
 * x316 — the database-free proof of request tags. It runs the controller over an in-memory tag store
 * and a fake request lookup, with the **real** `authorize`: the resolve-then-authorize order, the
 * cross-tenant 404 (no write), the capability gate (403, no write), the empty-label 400, the
 * duplicate 409 and the idempotent remove are what a wiring bug would break, and none needs MySQL.
 * The composite foreign key and the immutability trigger are proved against the engine by the chain.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'p1';
const REQUEST = 'request-0000-0000-0000-000000000001';
const CLIENT_ORG = 'client-org-0000-0000-000000000001';

const context = { organizationId: ORG } as unknown as TenantContext;

function scopedManager(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000002',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: 'membership-0000-0000-000000000002',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function request(): ClientRequestRow {
  const now = new Date();
  return {
    id: REQUEST,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: CLIENT_ORG,
    submittedByUserId: 'user-0000-0000-0000-0000-000000000009',
    title: 'Rebrand the homepage',
    category: 'general',
    description: 'Please refresh the hero.',
    urgencyReason: null,
    desiredAt: null,
    state: 'submitted',
    clarificationQuestion: null,
    clientVisibleReason: null,
    clientSafeScopeSummary: null,
    commitment: null,
    committedAt: null,
    linkedWorkItemId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as unknown as ClientRequestRow;
}

/** In-memory tag store standing in for the repository, counting its writes. */
class FakeTagsRepository {
  readonly rows: RequestTagRow[] = [];
  writes = 0;

  async listForRequest(_r: unknown, _c: TenantContext, clientRequestId: string) {
    return this.rows
      .filter((row) => row.clientRequestId === clientRequestId)
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  async findById(_r: unknown, _c: TenantContext, clientRequestId: string, tagId: string) {
    return (
      this.rows.find((row) => row.clientRequestId === clientRequestId && row.id === tagId) ?? null
    );
  }
  async findByLabel(_r: unknown, _c: TenantContext, clientRequestId: string, label: string) {
    return (
      this.rows.find(
        (row) =>
          row.clientRequestId === clientRequestId &&
          row.label.toLowerCase() === label.toLowerCase(),
      ) ?? null
    );
  }
  async create(
    _r: unknown,
    _c: TenantContext,
    input: { clientRequestId: string; label: string; createdBy: string },
  ) {
    this.writes += 1;
    const row = {
      id: `tag-${this.rows.length + 1}`,
      organizationId: ORG,
      clientRequestId: input.clientRequestId,
      label: input.label,
      createdBy: input.createdBy,
      createdAt: new Date(),
    } as unknown as RequestTagRow;
    this.rows.push(row);
    return row;
  }
  async deleteById(_r: unknown, _c: TenantContext, clientRequestId: string, tagId: string) {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i] as RequestTagRow;
      if (row.clientRequestId === clientRequestId && row.id === tagId) this.rows.splice(i, 1);
    }
    return this.rows.length < before;
  }
}

function harness(parent: ClientRequestRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const requests = { findById: async () => parent } as unknown as ClientRequestsRepository;
  const tags = new FakeTagsRepository();
  const service = new RequestTagsService(
    database,
    requests,
    tags as unknown as RequestTagsRepository,
  );
  return { controller: new RequestTagsController(service), tags };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('RequestTagsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(request());
  });

  it('tags a request, lists it, and removes it', async () => {
    const manager = scopedManager();
    const added = await h.controller.add(context, manager, REQUEST, { label: 'Urgent' });
    expect(added.clientRequestId).toBe(REQUEST);
    expect(added.tags).toHaveLength(1);
    expect(added.tags[0]).toMatchObject({ label: 'Urgent', createdByUserId: manager.userId });

    const listed = await h.controller.list(context, manager, REQUEST);
    expect(listed.tags).toHaveLength(1);

    await h.controller.remove(context, manager, REQUEST, added.tags[0]!.id);
    expect((await h.controller.list(context, manager, REQUEST)).tags).toHaveLength(0);
  });

  it('rejects an empty label with 400 and a duplicate (case-insensitively) with 409, writing once', async () => {
    const manager = scopedManager();
    expect(await statusOf(() => h.controller.add(context, manager, REQUEST, { label: '  ' }))).toBe(
      400,
    );
    await h.controller.add(context, manager, REQUEST, { label: 'Urgent' });
    expect(
      await statusOf(() => h.controller.add(context, manager, REQUEST, { label: 'urgent' })),
    ).toBe(409);
    expect(h.tags.writes).toBe(1);
  });

  it('refuses to tag without client_request.triage (a client) with 403 and no insert', async () => {
    const status = await statusOf(() =>
      h.controller.add(context, client(), REQUEST, { label: 'Urgent' }),
    );
    expect(status).toBe(403);
    expect(h.tags.writes).toBe(0);
  });

  it('answers 404 and writes nothing when the request is cross-tenant or absent', async () => {
    const { controller, tags } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, scopedManager(), REQUEST, { label: 'Urgent' }),
    );
    expect(status).toBe(404);
    expect(tags.writes).toBe(0);
  });
});
