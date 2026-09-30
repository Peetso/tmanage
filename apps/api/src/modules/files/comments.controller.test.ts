import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FileCommentsController } from './comments.controller.js';
import { FileCommentsService } from './comments.service.js';
import type { FileCommentsRepository } from './comments.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileCommentRow, ProjectRow } from '../../common/database/schema.js';

/**
 * x333 — the fast, database-free proof of file comments. It runs the controller over an in-memory
 * comment store, a fake file lookup and a fake project lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the capability refusal (403, no insert), the cross-tenant 404 (no
 * write) and the delete-own-only rule are what a wiring bug would break, and none needs MySQL. The
 * composite foreign key and the immutability trigger are proved against the engine by the chain's
 * DB suite.
 *
 * Client-visibility note: the files caps (`file.download` / `file.upload`) are NOT internal-only —
 * client roles hold them too — so a client principal does reach this path. What scopes a client is
 * the row-level `authorize` against the resolved file's audience (the same posture file tags take);
 * a client never sees an `internal`-audience file, so a cross-audience read fails at `readableFile`
 * (404), before any write.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const OTHER_MEMBERSHIP = '01890000-0000-7000-8000-000000000012';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const FILE_ID = '01890000-0000-7000-8000-000000000301';

const context = {
  organizationId: ORG,
  membershipId: '01890000-0000-7000-8000-000000000011',
} as unknown as TenantContext;

function member(role: 'member' | 'guest' = 'member'): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role,
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

/** In-memory comment store standing in for the repository, counting its writes. */
class FakeCommentsRepository {
  readonly rows: FileCommentRow[] = [];

  async listForFile(_r: unknown, _c: TenantContext, fileAssetId: string) {
    return this.rows
      .filter((row) => row.fileAssetId === fileAssetId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }
  async findOnFile(_r: unknown, _c: TenantContext, fileAssetId: string, commentId: string) {
    return this.rows.find((row) => row.fileAssetId === fileAssetId && row.id === commentId) ?? null;
  }
  async append(
    _r: unknown,
    _c: TenantContext,
    input: { fileAssetId: string; body: string; createdBy: string },
  ) {
    const row: FileCommentRow = {
      id: `c-${this.rows.length + 1}`,
      organizationId: ORG,
      fileAssetId: input.fileAssetId,
      body: input.body,
      createdBy: input.createdBy,
      createdAt: new Date(Date.now() + this.rows.length),
    };
    this.rows.push(row);
    return row;
  }
  async deleteOnFile(_r: unknown, _c: TenantContext, fileAssetId: string, commentId: string) {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i] as FileCommentRow;
      if (row.fileAssetId === fileAssetId && row.id === commentId) this.rows.splice(i, 1);
    }
    return this.rows.length < before;
  }
}

function harness(file: FileAssetRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = { findById: async () => file } as unknown as FileAssetsRepository;
  const projects = {
    findById: async () => ({ archivedAt: null }) as unknown as ProjectRow,
  } as unknown as ProjectsRepository;
  const comments = new FakeCommentsRepository();
  const service = new FileCommentsService(
    database,
    assets,
    projects,
    comments as unknown as FileCommentsRepository,
  );
  return { controller: new FileCommentsController(service), comments };
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

describe('FileCommentsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness(fileAsset());
  });

  it('adds comments and lists them oldest-first', async () => {
    const first = await h.controller.add(context, member(), FILE_ID, { body: 'First' });
    const second = await h.controller.add(context, member(), FILE_ID, { body: 'Second' });
    expect(first).toMatchObject({
      fileId: FILE_ID,
      body: 'First',
      createdBy: context.membershipId,
    });
    const listed = await h.controller.list(context, member(), FILE_ID);
    expect(listed.comments.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('rejects an empty body with 400 and writes nothing', async () => {
    expect(
      await statusOf(() => h.controller.add(context, member(), FILE_ID, { body: '   ' })),
    ).toBe(400);
    expect(h.comments.rows).toHaveLength(0);
  });

  it('deletes own comment (204) and is idempotent for an absent comment', async () => {
    const comment = await h.controller.add(context, member(), FILE_ID, { body: 'Mine' });
    await h.controller.remove(context, member(), FILE_ID, comment.id);
    expect(h.comments.rows).toHaveLength(0);
    // Idempotent: deleting it again is a 204 no-op, not a throw.
    await h.controller.remove(context, member(), FILE_ID, comment.id);
  });

  it('refuses a comment from a principal without the files write cap (403, no insert)', async () => {
    // A guest holds `file.download` (so it reads the file) but not `file.upload`: the write is
    // refused at the service's row-level authorize, and nothing is inserted.
    const status = await statusOf(() =>
      h.controller.add(context, member('guest'), FILE_ID, { body: 'Nope' }),
    );
    expect(status).toBe(403);
    expect(h.comments.rows).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the file is cross-tenant or absent', async () => {
    const { controller, comments } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, member(), FILE_ID, { body: 'Ghost' }),
    );
    expect(status).toBe(404);
    expect(comments.rows).toHaveLength(0);
  });

  it("refuses deleting another member's comment (403) and leaves it in place", async () => {
    const comment = await h.controller.add(context, member(), FILE_ID, { body: 'Mine' });
    // Rewrite authorship so the caller is not the author.
    (h.comments.rows[0] as FileCommentRow).createdBy = OTHER_MEMBERSHIP;
    const status = await statusOf(() =>
      h.controller.remove(context, member(), FILE_ID, comment.id),
    );
    expect(status).toBe(403);
    expect(h.comments.rows).toHaveLength(1);
  });
});
