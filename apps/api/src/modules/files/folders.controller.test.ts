import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FileFoldersController } from './folders.controller.js';
import { FileFoldersService } from './folders.service.js';
import type { FileFoldersRepository } from './folders.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileFolderRow, ProjectRow } from '../../common/database/schema.js';

/**
 * x332 — the fast, database-free proof of file folders. It runs the controller over an in-memory
 * folder store, a fake project lookup and a fake file lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write), the blank-name 400, the duplicate
 * 409, the non-empty-delete 409, the idempotent move and the missing-capability 403 are what a wiring
 * bug would break, and none needs MySQL. The composite foreign keys and the immutability trigger are
 * proved against the engine by the chain's DB suite.
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

/** A guest reads files (`file.download`) but cannot manage them (no `file.upload`). */
function guest(): Principal {
  return { ...member(), role: 'guest' };
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

function folderRow(id: string, over: Partial<FileFolderRow>): FileFolderRow {
  return {
    id,
    organizationId: ORG,
    projectId: null,
    fileId: null,
    folderId: null,
    name: null,
    createdBy: null,
    createdAt: new Date(),
    ...over,
  };
}

/** In-memory folder store standing in for the repository, counting its writes. */
class FakeFoldersRepository {
  readonly folders: FileFolderRow[] = [];
  readonly memberships: FileFolderRow[] = [];

  async listFolders(_r: unknown, _c: TenantContext, projectId: string) {
    return this.folders.filter((row) => row.projectId === projectId);
  }
  async findFolder(_r: unknown, _c: TenantContext, folderId: string) {
    return this.folders.find((row) => row.id === folderId) ?? null;
  }
  async findFolderByName(_r: unknown, _c: TenantContext, projectId: string, name: string) {
    return this.folders.find((row) => row.projectId === projectId && row.name === name) ?? null;
  }
  async createFolder(_r: unknown, _c: TenantContext, projectId: string, name: string, by: string) {
    const row = folderRow(`fld-${this.folders.length + 1}`, { projectId, name, createdBy: by });
    this.folders.push(row);
    return row;
  }
  async deleteFolder(_r: unknown, _c: TenantContext, folderId: string) {
    const i = this.folders.findIndex((row) => row.id === folderId);
    if (i >= 0) this.folders.splice(i, 1);
  }
  async listFolderContents(_r: unknown, _c: TenantContext, folderId: string) {
    return this.memberships.filter((row) => row.folderId === folderId);
  }
  async folderHasContents(_r: unknown, _c: TenantContext, folderId: string) {
    return this.memberships.some((row) => row.folderId === folderId);
  }
  async findMembership(_r: unknown, _c: TenantContext, fileId: string) {
    return this.memberships.find((row) => row.fileId === fileId) ?? null;
  }
  async createMembership(_r: unknown, _c: TenantContext, fileId: string, folderId: string) {
    const row = folderRow(`mem-${this.memberships.length + 1}`, { fileId, folderId });
    this.memberships.push(row);
    return row;
  }
  async updateMembership(_r: unknown, _c: TenantContext, fileId: string, folderId: string) {
    const row = this.memberships.find((r) => r.fileId === fileId) as FileFolderRow;
    row.folderId = folderId;
    return row;
  }
  async deleteMembership(_r: unknown, _c: TenantContext, fileId: string) {
    const before = this.memberships.length;
    for (let i = this.memberships.length - 1; i >= 0; i -= 1) {
      if ((this.memberships[i] as FileFolderRow).fileId === fileId) this.memberships.splice(i, 1);
    }
    return this.memberships.length < before;
  }
}

function harness(file: FileAssetRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = { findById: async () => file } as unknown as FileAssetsRepository;
  const projects = {
    findById: async () =>
      ({ id: PROJECT, organizationId: ORG, archivedAt: null }) as unknown as ProjectRow,
  } as unknown as ProjectsRepository;
  const folders = new FakeFoldersRepository();
  const service = new FileFoldersService(
    database,
    assets,
    projects,
    folders as unknown as FileFoldersRepository,
  );
  return { controller: new FileFoldersController(service), folders };
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

describe('FileFoldersController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(fileAsset());
  });

  it('creates a folder and lists it', async () => {
    const created = await h.controller.create(context, member(), PROJECT, { name: 'Contracts' });
    expect(created).toMatchObject({ projectId: PROJECT, name: 'Contracts' });
    const listed = await h.controller.list(context, member(), PROJECT);
    expect(listed.folders).toHaveLength(1);
    expect(listed.folders[0]).toMatchObject({ name: 'Contracts' });
  });

  it('rejects a duplicate folder name with 409 and a blank name with 400', async () => {
    await h.controller.create(context, member(), PROJECT, { name: 'Contracts' });
    expect(
      await statusOf(() => h.controller.create(context, member(), PROJECT, { name: 'Contracts' })),
    ).toBe(409);
    expect(
      await statusOf(() => h.controller.create(context, member(), PROJECT, { name: '   ' })),
    ).toBe(400);
  });

  it('files a file into a folder, re-files it idempotently, and sends it back to root', async () => {
    const a = await h.controller.create(context, member(), PROJECT, { name: 'A' });
    const b = await h.controller.create(context, member(), PROJECT, { name: 'B' });
    const first = await h.controller.move(context, member(), FILE_ID, { folderId: a.id });
    expect(first).toEqual({ fileId: FILE_ID, folderId: a.id });
    // Idempotent: re-filing moves the one membership row, never a second.
    const moved = await h.controller.move(context, member(), FILE_ID, { folderId: b.id });
    expect(moved).toEqual({ fileId: FILE_ID, folderId: b.id });
    expect(h.folders.memberships).toHaveLength(1);
    // Back to root removes the membership row.
    const rooted = await h.controller.move(context, member(), FILE_ID, { folderId: null });
    expect(rooted).toEqual({ fileId: FILE_ID, folderId: null });
    expect(h.folders.memberships).toHaveLength(0);
  });

  it('deletes an empty folder (204) but refuses a non-empty one with 409', async () => {
    const folder = await h.controller.create(context, member(), PROJECT, { name: 'Docs' });
    await h.controller.move(context, member(), FILE_ID, { folderId: folder.id });
    expect(await statusOf(() => h.controller.remove(context, member(), PROJECT, folder.id))).toBe(
      409,
    );
    await h.controller.move(context, member(), FILE_ID, { folderId: null });
    await expect(
      h.controller.remove(context, member(), PROJECT, folder.id),
    ).resolves.toBeUndefined();
    expect(h.folders.folders).toHaveLength(0);
  });

  it('refuses creation without the files capability with 403 and writes nothing', async () => {
    const status = await statusOf(() =>
      h.controller.create(context, guest(), PROJECT, { name: 'Nope' }),
    );
    expect(status).toBe(403);
    expect(h.folders.folders).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the moved file is cross-tenant or absent', async () => {
    const { controller, folders } = harness(null);
    folders.folders.push(folderRow('fld-1', { projectId: PROJECT, name: 'A' }));
    const status = await statusOf(() =>
      controller.move(context, member(), FILE_ID, { folderId: 'fld-1' }),
    );
    expect(status).toBe(404);
    expect(folders.memberships).toHaveLength(0);
  });

  it('answers 404 for an unknown or other-project target folder, and writes nothing', async () => {
    const status = await statusOf(() =>
      h.controller.move(context, member(), FILE_ID, { folderId: 'no-such-folder' }),
    );
    expect(status).toBe(404);
    expect(h.folders.memberships).toHaveLength(0);
  });
});
