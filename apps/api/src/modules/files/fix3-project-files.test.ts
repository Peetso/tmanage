import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { FileFoldersController } from './folders.controller.js';
import { FileFoldersService, PROJECT_FILES_LIMIT } from './folders.service.js';
import type { FileFoldersRepository } from './folders.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';

/**
 * FIX3 item 11 (FIL-01 Files hub) — `GET …/projects/:projectId/files`, database-free with the real
 * `authorize`: a member of the project gets its ready files projected (name, type, size, version),
 * a member of another project and a client principal get the one 404, and the repository is asked
 * for at most {@link PROJECT_FILES_LIMIT} rows.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const OTHER = '01890000-0000-7000-8000-000000000102';
const context = { organizationId: ORG } as unknown as TenantContext;

function member(projectIds: readonly string[]): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

const CLEAN = {
  detectedMimeType: 'application/pdf',
  sizeBytes: 2048,
  versionNo: 2,
  scanVerdict: 'clean',
  trustZone: 'private',
};

function harness(
  rows: readonly { asset: Record<string, unknown>; version: Record<string, unknown> }[] = [
    {
      asset: {
        id: 'file-1',
        projectId: PROJECT,
        name: 'brief.pdf',
        status: 'ready',
        audience: 'internal',
        purpose: 'deliverable',
        updatedAt: new Date('2026-11-09T10:00:00.000Z'),
      },
      version: CLEAN,
    },
  ],
  stored?: 'allow_labeled' | 'block',
  scanner?: { kind: 'none' | 'engine' },
) {
  const limits: number[] = [];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = {
    listReadyForProject: async (_r: unknown, _c: unknown, _projectId: string, limit: number) => {
      limits.push(limit);
      return rows;
    },
  } as unknown as FileAssetsRepository;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      ({ id, organizationId: ORG, archivedAt: null }) as unknown as ProjectRow,
  } as unknown as ProjectsRepository;
  const service = new FileFoldersService(
    database,
    assets,
    projects,
    {} as unknown as FileFoldersRepository,
    scanner,
    {
      findByKey: async () => (stored ? { settingValue: stored } : undefined),
    } as unknown as OrgSettingsRepository,
  );
  return { controller: new FileFoldersController(service), limits };
}

describe('project files list (FIX3 item 11)', () => {
  it('lists a member’s project files with their type, size and version', async () => {
    const { controller, limits } = harness();
    const { files } = await controller.files(context, member([PROJECT]), PROJECT);
    expect(files).toEqual([
      {
        id: 'file-1',
        projectId: PROJECT,
        name: 'brief.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        audience: 'internal',
        purpose: 'deliverable',
        versionNo: 2,
        updatedAt: '2026-11-09T10:00:00.000Z',
        scanStatus: 'clean',
        // FIX5 item 5: a deliverable's file is never deleted from Files.
        canDelete: false,
      },
    ]);
    expect(limits).toEqual([PROJECT_FILES_LIMIT]);
  });

  it('FIX4: lists a verified file no scanner judged as Not scanned, and hides one still verifying', async () => {
    const waiting = (id: string, version: Record<string, unknown>) => ({
      asset: {
        id,
        projectId: PROJECT,
        name: `${id}.csv`,
        status: 'scanning',
        audience: 'internal',
        purpose: 'message_attachment',
        updatedAt: new Date('2026-11-09T10:00:00.000Z'),
      },
      version,
    });
    const rows = [
      waiting('unscanned', { ...CLEAN, scanVerdict: 'unscanned', trustZone: 'quarantine' }),
      waiting('verifying', { ...CLEAN, detectedMimeType: null, scanVerdict: null }),
    ];
    const none = harness(rows, 'block', { kind: 'none' });
    const listed = (await none.controller.files(context, member([PROJECT]), PROJECT)).files;
    // No scanner: the owner's stored "block" cannot apply, so the file is usable, labelled.
    expect(listed.map((file) => [file.id, file.scanStatus])).toEqual([
      ['unscanned', 'not_scanned'],
    ]);
    // A real scanner and "Block until scanned": the waiting file is not listed yet.
    const blocked = harness(rows, 'block', { kind: 'engine' });
    expect((await blocked.controller.files(context, member([PROJECT]), PROJECT)).files).toEqual([]);
  });

  it('answers 404 to a member of another project and to a client', async () => {
    const { controller } = harness();
    await expect(controller.files(context, member([OTHER]), PROJECT)).rejects.toBeInstanceOf(
      ApiError,
    );
    const client: Principal = { ...member([PROJECT]), kind: 'client', role: 'client_viewer' };
    await expect(controller.files(context, client, PROJECT)).rejects.toMatchObject({
      status: 404,
    });
  });
});
