import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AttachmentVersionsController } from './attachment-versions.controller.js';
import { AttachmentVersionsService } from './attachment-versions.service.js';
import type { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ReviewCommentsRepository } from './review-comments.repository.js';
import type {
  InsertReviewThreadInput,
  ListReviewThreadsInput,
  ReviewThread,
  ReviewThreadsRepository,
} from './review-threads.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  AttachmentVersionRow,
  FileAssetRow,
  ProjectRow,
} from '../../common/database/schema.js';

/**
 * C7 — the database-free proof of plain-attachment version history: the controller over an
 * in-memory chain, fake asset and project lookups, and the **real** `authorize`. The composite
 * foreign keys, the unique version number and the append-only trigger are 0228's, proved by the
 * chain's DB suite.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const OTHER_PROJECT = '01890000-0000-7000-8000-000000000102';
const ROOT = '01890000-0000-7000-8000-000000000301';
const V2 = '01890000-0000-7000-8000-000000000302';
const V3 = '01890000-0000-7000-8000-000000000303';
const ELSEWHERE = '01890000-0000-7000-8000-000000000304';
const LOGO = '01890000-0000-7000-8000-000000000305';
const USER = '01890000-0000-7000-8000-000000000001';

const context = { organizationId: ORG } as unknown as TenantContext;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
    ...over,
  } as Principal;
}

function asset(id: string, over: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: null,
    ownerUserId: USER,
    name: `${id.slice(-3)}.pdf`,
    purpose: 'deliverable',
    objectId: null,
    audience: 'internal',
    status: 'ready',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    ...over,
  } as unknown as FileAssetRow;
}

class FakeVersions {
  readonly rows: AttachmentVersionRow[] = [];
  async create(_r: unknown, _c: TenantContext, input: Omit<AttachmentVersionRow, 'id'>) {
    const row = {
      ...input,
      id: `ver-${this.rows.length + 1}`,
      organizationId: ORG,
      createdAt: new Date('2026-10-02T10:00:00.000Z'),
    } as AttachmentVersionRow;
    this.rows.push(row);
    return row;
  }
  async listForRoot(_r: unknown, _c: TenantContext, root: string) {
    return this.rows.filter((row) => row.rootFileAssetId === root);
  }
  async findInvolving(_r: unknown, _c: TenantContext, id: string) {
    return this.rows.find((row) => row.fileAssetId === id || row.rootFileAssetId === id) ?? null;
  }
}

/** The version a file's bytes were uploaded as: one per asset in these tests. */
const fv = (assetId: string) => `fv-${assetId}`;

/** R4 slice 11 — threads and comments, in memory, with 0269's unique key on number + scope. */
class FakeThreads {
  readonly rows: ReviewThread[] = [];
  seed(over: Partial<ReviewThread>): ReviewThread {
    const row = {
      id: `01890000-0000-7000-8000-${String(900 + this.rows.length + 1).padStart(12, '0')}`,
      organizationId: ORG,
      projectId: PROJECT,
      subjectType: 'file_asset',
      subjectId: ROOT,
      fileVersionId: fv(ROOT),
      anchorKind: 'pin',
      anchor: { x: 0.25, y: 0.5 },
      pageNo: null,
      timeMs: null,
      number: this.rows.length + 1,
      audience: 'internal',
      status: 'open',
      carriedFromThreadId: null,
      carryScope: '',
      createdByMembershipId: 'm-author',
      deletedAt: null,
      ...over,
    } as ReviewThread;
    this.rows.push(row);
    return row;
  }
  async listForSubject(_r: unknown, _c: TenantContext, input: ListReviewThreadsInput) {
    return this.rows.filter(
      (row) =>
        row.subjectId === input.subjectId &&
        (input.fileVersionId === undefined || row.fileVersionId === input.fileVersionId) &&
        (input.status === undefined || row.status === input.status) &&
        input.audiences.includes(row.audience) &&
        row.deletedAt === null,
    );
  }
  async insert(_r: unknown, _c: TenantContext, input: InsertReviewThreadInput) {
    const scope = input.carryScope ?? '';
    if (
      this.rows.some(
        (row) =>
          row.subjectId === input.subjectId &&
          row.number === input.number &&
          row.carryScope === scope,
      )
    ) {
      throw Object.assign(new Error('dup'), { errno: 1062 });
    }
    return this.seed({ ...input, carryScope: scope, status: 'open' } as Partial<ReviewThread>);
  }
}

class FakeComments {
  readonly rows: {
    threadId: string;
    body: string;
    mentions: readonly string[];
    createdByMembershipId: string;
    createdAt: Date;
    deletedAt: Date | null;
  }[] = [];
  async listForThreads(_r: unknown, _c: TenantContext, ids: readonly string[]) {
    return this.rows.filter((row) => ids.includes(row.threadId) && row.deletedAt === null);
  }
  async insert(
    _r: unknown,
    _c: TenantContext,
    input: {
      threadId: string;
      body: string;
      mentions: readonly string[];
      createdByMembershipId: string;
      createdAt?: Date;
    },
  ) {
    const row = { ...input, createdAt: input.createdAt ?? new Date(), deletedAt: null };
    this.rows.push(row);
    return row;
  }
}

function harness(files: readonly FileAssetRow[]) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = {
    findById: async (_r: unknown, _c: unknown, id: string) => byId.get(id) ?? null,
    findLatestVersion: async (_r: unknown, _c: unknown, id: string) =>
      byId.has(id) ? { id: fv(id), fileAssetId: id } : null,
  } as unknown as FileAssetsRepository;
  const projects = {
    findById: async () => ({ archivedAt: null }) as unknown as ProjectRow,
  } as unknown as ProjectsRepository;
  const audited: string[] = [];
  const audit = {
    record: async (_r: unknown, _c: unknown, input: { action: string }) => {
      audited.push(input.action);
    },
  } as unknown as AuditService;
  const versions = new FakeVersions();
  const threads = new FakeThreads();
  const comments = new FakeComments();
  const service = new AttachmentVersionsService(
    database,
    assets,
    projects,
    audit,
    versions as unknown as AttachmentVersionsRepository,
    threads as unknown as ReviewThreadsRepository,
    comments as unknown as ReviewCommentsRepository,
  );
  return {
    controller: new AttachmentVersionsController(service),
    versions,
    audited,
    threads,
    comments,
  };
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

describe('AttachmentVersionsController', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness([
      asset(ROOT),
      asset(V2, { status: 'scanning' }),
      asset(V3),
      asset(ELSEWHERE, { projectId: OTHER_PROJECT }),
      asset(LOGO, { purpose: 'org_logo' }),
    ]);
  });

  it('lists a plain attachment with no history as version 1, current', async () => {
    const history = await h.controller.list(context, principal(), ROOT);
    expect(history.versions).toEqual([
      expect.objectContaining({
        versionNo: 1,
        fileAssetId: ROOT,
        current: true,
        createdByUserId: USER,
      }),
    ]);
  });

  it('uploads a new version: numbered 2, newest first, audited', async () => {
    const history = await h.controller.add(context, principal(), ROOT, {
      fileAssetId: V2,
      note: ' second cut ',
    });
    expect(history.versions.map((v) => [v.versionNo, v.fileAssetId, v.current])).toEqual([
      [2, V2, true],
      [1, ROOT, false],
    ]);
    expect(history.versions[0]).toMatchObject({ note: 'second cut', availability: 'scanning' });
    expect(h.audited).toEqual(['file_asset.version_added']);
  });

  it('keeps every previous version downloadable by its own asset id, and resolves any version to the same history', async () => {
    await h.controller.add(context, principal(), ROOT, { fileAssetId: V2 });
    const history = await h.controller.add(context, principal(), V2, { fileAssetId: V3 });
    expect(history.rootFileAssetId).toBe(ROOT);
    expect(history.versions.map((v) => v.fileAssetId)).toEqual([V3, V2, ROOT]);
    const fromOld = await h.controller.list(context, principal(), V2);
    expect(fromOld.versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
  });

  it('refuses a file of another project, the same file, or one already in a chain (422)', async () => {
    expect(
      await statusOf(() =>
        h.controller.add(context, principal(), ROOT, { fileAssetId: ELSEWHERE }),
      ),
    ).toBe(422);
    expect(
      await statusOf(() => h.controller.add(context, principal(), ROOT, { fileAssetId: ROOT })),
    ).toBe(422);
    await h.controller.add(context, principal(), ROOT, { fileAssetId: V2 });
    expect(
      await statusOf(() => h.controller.add(context, principal(), V3, { fileAssetId: V2 })),
    ).toBe(422);
    expect(h.versions.rows).toHaveLength(1);
  });

  it('answers 404 for an unknown id, a non-attachment purpose, or a project the caller cannot read', async () => {
    expect(await statusOf(() => h.controller.list(context, principal(), 'missing'))).toBe(404);
    expect(await statusOf(() => h.controller.list(context, principal(), LOGO))).toBe(404);
    expect(
      await statusOf(() =>
        h.controller.add(context, principal({ projectIds: [] }), ROOT, { fileAssetId: V2 }),
      ),
    ).toBe(404);
    expect(h.versions.rows).toHaveLength(0);
  });

  it('refuses a client principal and a body without a file id', async () => {
    expect(
      await statusOf(() =>
        h.controller.list(context, principal({ kind: 'client', clientOrganizationId: 'c' }), ROOT),
      ),
    ).toBe(403);
    expect(await statusOf(() => h.controller.add(context, principal(), ROOT, {}))).toBe(400);
  });

  describe('R4 slice 11 — carrying open comments to the new version', () => {
    it('copies only the open threads of the version before, keeping numbers, places and audience', async () => {
      const open1 = h.threads.seed({ number: 1, audience: 'client_visible' });
      h.threads.seed({ number: 2, status: 'resolved' });
      const open3 = h.threads.seed({
        number: 3,
        anchorKind: 'box',
        anchor: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      });
      h.comments.rows.push(
        {
          threadId: open1.id,
          body: 'Use the brand lime',
          mentions: [],
          createdByMembershipId: 'm-client',
          createdAt: new Date('2026-10-20T09:00:00.000Z'),
          deletedAt: null,
        },
        {
          threadId: open1.id,
          body: 'Will do',
          mentions: [],
          createdByMembershipId: 'm-staff',
          createdAt: new Date('2026-10-20T10:00:00.000Z'),
          deletedAt: null,
        },
      );

      const added = await h.controller.add(context, principal(), ROOT, { fileAssetId: V2 });

      expect(added.carriedThreads).toBe(2);
      const copies = h.threads.rows.filter((row) => row.fileVersionId === fv(V2));
      expect(
        copies.map((row) => [row.number, row.audience, row.carriedFromThreadId, row.carryScope]),
      ).toEqual([
        [1, 'client_visible', open1.id, fv(V2)],
        [3, 'internal', open3.id, fv(V2)],
      ]);
      expect(copies[1]?.anchor).toEqual(open3.anchor);
      expect(copies.every((row) => row.subjectId === ROOT && row.status === 'open')).toBe(true);
      // The conversation travels with its times; the originals stay where they were.
      const copied = h.comments.rows.filter((row) => row.threadId === copies[0]?.id);
      expect(copied.map((row) => [row.body, row.createdByMembershipId])).toEqual([
        ['Use the brand lime', 'm-client'],
        ['Will do', 'm-staff'],
      ]);
      expect(copied[0]?.createdAt.toISOString()).toBe('2026-10-20T09:00:00.000Z');
      expect(h.threads.rows.filter((row) => row.fileVersionId === fv(ROOT))).toHaveLength(3);
    });

    it('carries from the newest version, so a comment carried twice keeps its number', async () => {
      const first = h.threads.seed({ number: 1 });
      await h.controller.add(context, principal(), ROOT, { fileAssetId: V2 });
      const added = await h.controller.add(context, principal(), V2, { fileAssetId: V3 });
      expect(added.carriedThreads).toBe(1);
      const onV3 = h.threads.rows.filter((row) => row.fileVersionId === fv(V3));
      expect(onV3).toHaveLength(1);
      expect(onV3[0]?.number).toBe(first.number);
      const onV2 = h.threads.rows.find((row) => row.fileVersionId === fv(V2));
      expect(onV3[0]?.carriedFromThreadId).toBe(onV2?.id);
    });

    it("carries nothing with carryForward 'none', and only the ticked threads when named", async () => {
      const a = h.threads.seed({ number: 1 });
      h.threads.seed({ number: 2 });
      const none = await h.controller.add(context, principal(), ROOT, {
        fileAssetId: V2,
        carryForward: 'none',
      });
      expect(none.carriedThreads).toBe(0);
      expect(h.threads.rows).toHaveLength(2);

      const h2 = harness([asset(ROOT), asset(V2)]);
      const kept = h2.threads.seed({ number: 1 });
      h2.threads.seed({ number: 2 });
      const some = await h2.controller.add(context, principal(), ROOT, {
        fileAssetId: V2,
        carryThreadIds: [kept.id],
      });
      expect(some.carriedThreads).toBe(1);
      expect(
        h2.threads.rows
          .filter((row) => row.fileVersionId === fv(V2))
          .map((row) => row.carriedFromThreadId),
      ).toEqual([kept.id]);
      expect(a.number).toBe(1);
    });

    it('refuses a bad carry choice (400)', async () => {
      expect(
        await statusOf(() =>
          h.controller.add(context, principal(), ROOT, { fileAssetId: V2, carryForward: 'all' }),
        ),
      ).toBe(400);
      expect(
        await statusOf(() =>
          h.controller.add(context, principal(), ROOT, {
            fileAssetId: V2,
            carryThreadIds: ['not-an-id'],
          }),
        ),
      ).toBe(400);
      expect(h.versions.rows).toHaveLength(0);
    });
  });
});
