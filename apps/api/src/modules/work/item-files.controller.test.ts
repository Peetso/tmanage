import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemFilesController } from './item-files.controller.js';
import { WorkItemFilesService } from './item-files.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, WorkItemFileRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x205 — the fast, database-free proof of the work-item ↔ file attachment join (Work module 7).
 *
 * It runs the controller over an in-memory link store, a fake work-item lookup and a fake file
 * lookup, with the **real** `authorize`. The behaviours a wiring bug would break are the ones a
 * cross-module tenant join must never get wrong: resolve-then-authorize on the work item, the
 * cross-tenant file id and cross-tenant work item both answering 404 with no write, the same-
 * project requirement on the file, and the `work.update` gate on attach. The two composite
 * foreign keys and the immutability trigger are proved against the real engine by the chain's DB
 * suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const OTHER_PROJECT = '01890000-0000-7000-8000-000000000102';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const FILE_ID = '01890000-0000-7000-8000-000000000301';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

function member(projectIds: readonly string[]): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function workItem(over: Partial<WorkItemRow> = {}): WorkItemRow {
  const now = new Date();
  return {
    id: WORK_ID,
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'Assemble the brand book',
    state: 'in_progress',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}

function fileAsset(over: Partial<FileAssetRow> = {}): FileAssetRow {
  const now = new Date();
  return {
    id: FILE_ID,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: null,
    ownerUserId: '01890000-0000-7000-8000-000000000001',
    name: 'brand-book.pdf',
    purpose: 'document',
    objectId: null,
    audience: 'internal',
    status: 'ready',
    rejectionCode: null,
    scanClaimedAt: null,
    purgedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as FileAssetRow;
}

/** An in-memory link store standing in for the repository, counting its writes. */
class FakeLinksRepository {
  readonly rows: (WorkItemFileRow & { fileName: string; status: string })[] = [];
  creates = 0;
  deletes = 0;

  async findByPair(_r: unknown, _c: TenantContext, workItemId: string, fileAssetId: string) {
    return (
      this.rows.find((row) => row.workItemId === workItemId && row.fileAssetId === fileAssetId) ??
      null
    );
  }

  async listForWorkItem(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.rows
      .filter((row) => row.workItemId === workItemId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: { workItemId: string; fileAssetId: string; attachedByMembershipId: string },
  ) {
    this.creates += 1;
    const row = {
      id: `link-${this.rows.length + 1}`,
      organizationId: ORG,
      workItemId: input.workItemId,
      fileAssetId: input.fileAssetId,
      attachedByMembershipId: input.attachedByMembershipId,
      createdAt: new Date(Date.now() + this.rows.length),
      fileName: 'brand-book.pdf',
      status: 'ready',
    };
    this.rows.push(row);
    return row;
  }

  async delete(_r: unknown, _c: TenantContext, workItemId: string, linkId: string) {
    const before = this.rows.length;
    const remaining = this.rows.filter(
      (row) => !(row.workItemId === workItemId && row.id === linkId),
    );
    this.rows.length = 0;
    this.rows.push(...remaining);
    const removed = this.rows.length < before;
    if (removed) this.deletes += 1;
    return removed;
  }
}

function harness(parent: WorkItemRow | null, file: FileAssetRow | null = fileAsset()) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const fileAssets = { findById: async () => file } as unknown as FileAssetsRepository;
  const links = new FakeLinksRepository();
  const service = new WorkItemFilesService(
    database,
    workItems,
    fileAssets,
    links as unknown as ConstructorParameters<typeof WorkItemFilesService>[3],
  );
  return { controller: new WorkItemFilesController(service), links };
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

describe('WorkItemFilesController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('attaches, lists and detaches for a related member', async () => {
    const { controller, links } = harnessed;
    const related = member([PROJECT]);

    const attached = await controller.attach(context, related, WORK_ID, { fileAssetId: FILE_ID });
    expect(attached).toMatchObject({
      workItemId: WORK_ID,
      fileAssetId: FILE_ID,
      fileName: 'brand-book.pdf',
      availability: 'ready',
      attachedByMembershipId: MEMBERSHIP,
    });

    const listed = await controller.list(context, related, WORK_ID);
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]?.id).toBe(attached.id);
    expect(listed.files[0]?.availability).toBe('ready');

    await controller.detach(context, related, WORK_ID, attached.id);
    expect(links.deletes).toBe(1);
    const afterDetach = await controller.list(context, related, WORK_ID);
    expect(afterDetach.files).toHaveLength(0);
  });

  it('is idempotent: attaching the same file twice returns the existing link and writes once', async () => {
    const { controller, links } = harnessed;
    const related = member([PROJECT]);
    const first = await controller.attach(context, related, WORK_ID, { fileAssetId: FILE_ID });
    const second = await controller.attach(context, related, WORK_ID, { fileAssetId: FILE_ID });
    expect(second.id).toBe(first.id);
    expect(links.creates).toBe(1);
  });

  it('answers 404 and writes nothing when the file id is cross-tenant or absent', async () => {
    const { controller, links } = harness(workItem(), null);
    const status = await statusOf(() =>
      controller.attach(context, member([PROJECT]), WORK_ID, { fileAssetId: FILE_ID }),
    );
    expect(status).toBe(404);
    expect(links.creates).toBe(0);
  });

  it('answers 404 and writes nothing when the file belongs to a different project', async () => {
    const { controller, links } = harness(workItem(), fileAsset({ projectId: OTHER_PROJECT }));
    const status = await statusOf(() =>
      controller.attach(context, member([PROJECT]), WORK_ID, { fileAssetId: FILE_ID }),
    );
    expect(status).toBe(404);
    expect(links.creates).toBe(0);
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, links } = harness(null);
    const status = await statusOf(() =>
      controller.attach(context, member([PROJECT]), WORK_ID, { fileAssetId: FILE_ID }),
    );
    expect(status).toBe(404);
    expect(links.creates).toBe(0);
  });

  it('gates the list behind read access: an unrelated member gets 404', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });

  it('refuses the attach with 403 when the caller may read the item but not update it', async () => {
    // An archived item permits an internal read for history but denies every write — real
    // `authorize`, `resource_not_active`. The reader is related, so its existence is not a
    // secret: the refusal is 403, not the 404 an unrelated caller would get.
    const { controller, links } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.attach(context, member([PROJECT]), WORK_ID, { fileAssetId: FILE_ID }),
    );
    expect(status).toBe(403);
    expect(links.creates).toBe(0);
  });

  it('rejects a missing fileAssetId with 400 before any lookup', async () => {
    const { controller, links } = harnessed;
    const status = await statusOf(() =>
      controller.attach(context, member([PROJECT]), WORK_ID, { fileAssetId: '' }),
    );
    expect(status).toBe(400);
    expect(links.creates).toBe(0);
  });
});
