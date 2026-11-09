import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FileDeleteController } from './file-delete.controller.js';
import { FileDeleteService, mayDeleteFile } from './file-delete.service.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, ProjectRow } from '../../common/database/schema.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';

/**
 * FIX5 item 5 (live bug B-N5) — `DELETE …/files/:fileId` and `POST …/files/:fileId/restore`,
 * database-free with the real `authorize`. The uploader, a manager of the file's project and the
 * company owner may delete and restore; another member of the project gets 403, a caller outside
 * it the 404 an unknown id gives. Both writes are idempotent and audited once.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const OTHER_PROJECT = '01890000-0000-7000-8000-000000000102';
const FILE = '01890000-0000-7000-8000-0000000000f1';
const UPLOADER = '01890000-0000-7000-8000-000000000001';
const context = { organizationId: ORG, userId: UPLOADER } as unknown as TenantContext;

function principal(
  userId: string,
  role: Principal['role'],
  projectIds: readonly string[] = [PROJECT],
  orgWide = false,
): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: `m-${userId}`,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const uploader = principal(UPLOADER, 'member');
const otherMember = principal('01890000-0000-7000-8000-000000000002', 'member');
const projectManager = principal('01890000-0000-7000-8000-000000000003', 'manager');
const owner = principal('01890000-0000-7000-8000-000000000004', 'owner', [], true);
const outsider = principal('01890000-0000-7000-8000-000000000005', 'member', [OTHER_PROJECT]);

function fileRow(overrides: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id: FILE,
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: null,
    ownerUserId: UPLOADER,
    name: 'quote.csv',
    purpose: 'message_attachment',
    audience: 'internal',
    status: 'ready',
    deletedAt: null,
    purgedAt: null,
    purgeAfter: null,
    ...overrides,
  } as unknown as FileAssetRow;
}

function harness(initial: FileAssetRow = fileRow(), restoreWindowOpen = true) {
  let row = initial;
  const writes: string[] = [];
  const audits: string[] = [];
  const database = {
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    read: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === row.id ? row : null),
    softDelete: async () => {
      if (row.deletedAt !== null) return false;
      writes.push('delete');
      row = { ...row, deletedAt: new Date() } as FileAssetRow;
      return true;
    },
    restore: async () => {
      if (row.deletedAt === null || !restoreWindowOpen) return false;
      writes.push('restore');
      row = { ...row, deletedAt: null } as FileAssetRow;
      return true;
    },
  } as unknown as FileAssetsRepository;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      ({ id, organizationId: ORG, archivedAt: null }) as unknown as ProjectRow,
  } as unknown as ProjectsRepository;
  const audit = {
    record: async (_tx: unknown, _c: unknown, input: { action: string }) => {
      audits.push(input.action);
    },
  } as unknown as AuditService;
  const service = new FileDeleteService(database, assets, projects, audit);
  return {
    controller: new FileDeleteController(service),
    writes,
    audits,
    current: () => row,
  };
}

async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as { status: number }).status;
  }
}

describe('file delete (FIX5 item 5)', () => {
  it('lets the uploader delete, then restore, the file — each audited once', async () => {
    const t = harness();
    await t.controller.remove(context, uploader, FILE);
    expect(t.current().deletedAt).not.toBeNull();
    await t.controller.restore(context, uploader, FILE);
    expect(t.current().deletedAt).toBeNull();
    expect(t.writes).toEqual(['delete', 'restore']);
    expect(t.audits).toEqual(['file_asset.deleted', 'file_asset.restored']);
  });

  it('lets a manager of the file’s project and the company owner delete', async () => {
    for (const who of [projectManager, owner]) {
      const t = harness();
      expect(await status(t.controller.remove(context, who, FILE))).toBe('ok');
      expect(t.writes).toEqual(['delete']);
    }
  });

  it('refuses another member of the project with 403 and changes nothing', async () => {
    const t = harness();
    expect(await status(t.controller.remove(context, otherMember, FILE))).toBe(403);
    expect(await status(t.controller.restore(context, otherMember, FILE))).toBe(403);
    expect(t.writes).toEqual([]);
    expect(t.audits).toEqual([]);
  });

  it('answers 404 to a caller outside the project, for an unknown id and for a bad id', async () => {
    const t = harness();
    expect(await status(t.controller.remove(context, outsider, FILE))).toBe(404);
    expect(
      await status(t.controller.remove(context, uploader, '01890000-0000-7000-8000-0000000000ff')),
    ).toBe(404);
    expect(await status(t.controller.remove(context, uploader, 'not-an-id'))).toBe(404);
    expect(t.writes).toEqual([]);
  });

  it('is idempotent: a second delete and a restore of a live file change nothing', async () => {
    const t = harness();
    await t.controller.remove(context, uploader, FILE);
    await t.controller.remove(context, uploader, FILE);
    expect(t.writes).toEqual(['delete']);
    expect(t.audits).toEqual(['file_asset.deleted']);

    const live = harness();
    await live.controller.restore(context, uploader, FILE);
    expect(live.writes).toEqual([]);
    expect(live.audits).toEqual([]);
  });

  it('cannot restore once the restore window has passed (404)', async () => {
    const t = harness(fileRow({ deletedAt: new Date() } as Partial<FileAssetRow>), false);
    expect(await status(t.controller.restore(context, uploader, FILE))).toBe(404);
    expect(t.audits).toEqual([]);
  });

  it('never removes a deliverable’s file, nor lets a client remove one', () => {
    const deliverable = fileRow({ purpose: 'deliverable' } as Partial<FileAssetRow>);
    expect(mayDeleteFile(owner, deliverable, false)).toBe(false);
    expect(mayDeleteFile({ ...uploader, kind: 'client' }, fileRow(), false)).toBe(false);
    expect(mayDeleteFile(uploader, fileRow(), false)).toBe(true);
    expect(mayDeleteFile(otherMember, fileRow(), false)).toBe(false);
    // An archived project is read-only: not even the uploader deletes there.
    expect(mayDeleteFile(uploader, fileRow(), true)).toBe(false);
  });

  it('gates both routes on file.upload (the uploader is an ordinary member)', () => {
    const proto = FileDeleteController.prototype;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto.remove)).toBe('file.upload');
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto.restore)).toBe('file.upload');
  });
});
