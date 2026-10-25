import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FileTagsController } from './file-tags.controller.js';
import { FileTagsService } from './file-tags.service.js';
import type { FileTagsRepository } from './file-tags.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { FileClientRelation } from './file-client-relation.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileTagRow, ProjectRow } from '../../common/database/schema.js';

/**
 * x270 — the fast, database-free proof of file tags. It runs the controller over an in-memory tag
 * store, a fake file lookup and a fake project lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write), the unique-name 409 and idempotent
 * tagging are what a wiring bug would break, and none needs MySQL. The composite foreign keys and the
 * immutability trigger are proved against the engine by the chain's DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const FILE_ID = '01890000-0000-7000-8000-000000000301';

const context = { organizationId: ORG } as unknown as TenantContext;

function member(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function fileAsset(): FileAssetRow {
  return {
    id: FILE_ID,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: null,
    audience: 'internal',
  } as unknown as FileAssetRow;
}

function row_(id: string, over: Partial<FileTagRow>): FileTagRow {
  return {
    id,
    organizationId: ORG,
    fileId: null,
    tagId: null,
    name: null,
    createdAt: new Date(),
    ...over,
  };
}

/** In-memory tag store standing in for the repository, counting its writes. */
class FakeTagsRepository {
  readonly defs: FileTagRow[] = [];
  readonly assigns: FileTagRow[] = [];

  async listDefinitions() {
    return [...this.defs].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }
  async findDefinition(_r: unknown, _c: TenantContext, tagId: string) {
    return this.defs.find((row) => row.id === tagId) ?? null;
  }
  async findDefinitionByName(_r: unknown, _c: TenantContext, name: string) {
    return this.defs.find((row) => row.name === name) ?? null;
  }
  async createDefinition(_r: unknown, _c: TenantContext, name: string) {
    const row = row_(`def-${this.defs.length + 1}`, { name });
    this.defs.push(row);
    return row;
  }
  async listAssignments(_r: unknown, _c: TenantContext, fileId: string) {
    return this.assigns.filter((row) => row.fileId === fileId);
  }
  async findAssignment(_r: unknown, _c: TenantContext, fileId: string, tagId: string) {
    return this.assigns.find((row) => row.fileId === fileId && row.tagId === tagId) ?? null;
  }
  async createAssignment(_r: unknown, _c: TenantContext, fileId: string, tagId: string) {
    const row = row_(`asg-${this.assigns.length + 1}`, { fileId, tagId });
    this.assigns.push(row);
    return row;
  }
  async deleteAssignment(_r: unknown, _c: TenantContext, fileId: string, tagId: string) {
    const before = this.assigns.length;
    for (let i = this.assigns.length - 1; i >= 0; i -= 1) {
      const row = this.assigns[i] as FileTagRow;
      if (row.fileId === fileId && row.tagId === tagId) this.assigns.splice(i, 1);
    }
    return this.assigns.length < before;
  }
}

function harness(file: FileAssetRow | null, relation?: FileClientRelation) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = { findById: async () => file } as unknown as FileAssetsRepository;
  const projects = {
    findById: async () => ({ archivedAt: null }) as unknown as ProjectRow,
  } as unknown as ProjectsRepository;
  const tags = new FakeTagsRepository();
  const service = new FileTagsService(
    database,
    assets,
    projects,
    tags as unknown as FileTagsRepository,
    relation,
  );
  return { controller: new FileTagsController(service), tags };
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

describe('FileTagsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(fileAsset());
  });

  it('defines a tag and lists it', async () => {
    const defined = await h.controller.define(context, { name: 'Contract' });
    expect(defined).toMatchObject({ name: 'Contract' });
    const listed = await h.controller.list(context);
    expect(listed.tags).toHaveLength(1);
    expect(listed.tags[0]).toMatchObject({ name: 'Contract' });
  });

  it('rejects a duplicate tag name with 409 and a blank name with 400', async () => {
    await h.controller.define(context, { name: 'Contract' });
    expect(await statusOf(() => h.controller.define(context, { name: 'Contract' }))).toBe(409);
    expect(await statusOf(() => h.controller.define(context, { name: '   ' }))).toBe(400);
  });

  it('assigns a tag to a file and removes it, idempotently', async () => {
    const tag = await h.controller.define(context, { name: 'Contract' });
    const first = await h.controller.assign(context, member(), FILE_ID, tag.id);
    expect(first).toMatchObject({ fileId: FILE_ID, tagId: tag.id, name: 'Contract' });
    // Idempotent: a second identical assign does not create a duplicate.
    await h.controller.assign(context, member(), FILE_ID, tag.id);
    expect((await h.controller.listForFile(context, member(), FILE_ID)).tags).toHaveLength(1);
    await h.controller.remove(context, member(), FILE_ID, tag.id);
    expect((await h.controller.listForFile(context, member(), FILE_ID)).tags).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the file is cross-tenant or absent', async () => {
    const { controller, tags } = harness(null);
    const tag = row_('def-x', { name: 'X' });
    tags.defs.push(tag);
    const status = await statusOf(() => controller.assign(context, member(), FILE_ID, tag.id));
    expect(status).toBe(404);
    expect(tags.assigns).toHaveLength(0);
  });

  it('answers 404 for an unknown or cross-tenant tag id', async () => {
    const status = await statusOf(() =>
      h.controller.assign(context, member(), FILE_ID, 'no-such-tag'),
    );
    expect(status).toBe(404);
    expect(h.tags.assigns).toHaveLength(0);
  });
});

// ── F35 (security audit): a client principal is held to the request row, not the asset row ──

const CLIENT_ORG_X = '01890000-0000-7000-8000-0000000000c1';
const CLIENT_ORG_Y = '01890000-0000-7000-8000-0000000000c2';
const REQUEST_X = '01890000-0000-7000-8000-000000000401';

function clientOf(clientOrganizationId: string): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000002',
    organizationId: ORG,
    kind: 'client',
    role: 'client_member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

/** A staff upload on client org X's request: client_visible, no client organization on the asset. */
function staffRequestFile(purpose = 'request_attachment'): FileAssetRow {
  return {
    id: FILE_ID,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: null,
    audience: 'client_visible',
    purpose,
    objectId: REQUEST_X,
  } as unknown as FileAssetRow;
}

function relationFor(): FileClientRelation {
  const requests = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === REQUEST_X ? { id, projectId: PROJECT, clientOrganizationId: CLIENT_ORG_X } : null,
  } as unknown as ClientRequestsRepository;
  return new FileClientRelation(requests);
}

describe('FileTagsController — F35 client relation', () => {
  it('answers a sibling client org 404 on list, assign and remove, and writes nothing', async () => {
    const { controller, tags } = harness(staffRequestFile(), relationFor());
    const defined = await controller.define(context, { name: 'Final' });
    const sibling = clientOf(CLIENT_ORG_Y);
    expect(await statusOf(() => controller.listForFile(context, sibling, FILE_ID))).toBe(404);
    expect(await statusOf(() => controller.assign(context, sibling, FILE_ID, defined.id))).toBe(
      404,
    );
    expect(await statusOf(() => controller.remove(context, sibling, FILE_ID, defined.id))).toBe(
      404,
    );
    expect(tags.assigns).toHaveLength(0);
  });

  it('keeps the owning client org working on its own request file', async () => {
    const { controller } = harness(staffRequestFile(), relationFor());
    const defined = await controller.define(context, { name: 'Final' });
    const owner = clientOf(CLIENT_ORG_X);
    await controller.assign(context, owner, FILE_ID, defined.id);
    const listed = await controller.listForFile(context, owner, FILE_ID);
    expect(listed.tags.map((t) => t.tagId)).toEqual([defined.id]);
  });
});
