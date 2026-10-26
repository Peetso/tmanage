import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageConnectionRow, WorkItemRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { GoogleDriveStorageController } from './google-drive.controller.js';
import {
  FOLDER_MIME_TYPE,
  createDriveTransport,
  type DriveFile,
  type DriveTransport,
} from './google-drive.google.js';
import type {
  GoogleDriveRepository,
  KnownDriveFolder,
  ProjectDriveFolder,
} from './google-drive.repository.js';
import { GoogleDriveService, tokenBinding } from './google-drive.service.js';

/**
 * Wave 11 Q1 — NV10 (the company-wide `drive.file` token reached project-scoped members) and M04
 * (the V2 attach check looked at the direct parent only). Fake transport and repository; no
 * database, no Google.
 */

const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x55).toString('base64url')}`));
const ORG = 'org-a';
const PA = '01890000-0000-7000-8000-000000000401';
const PB = '01890000-0000-7000-8000-000000000402';
const ITEM_A = '01890000-0000-7000-8000-000000000501';
const ITEM_B = '01890000-0000-7000-8000-000000000502';
const ROOT = 'root_folder_1';
const FILE_ID = 'file_abcdef12345';

const KNOWN: readonly KnownDriveFolder[] = [
  { driveFolderId: 'folder_pa', rootFolderId: ROOT, projectId: PA },
  { driveFolderId: 'folder_item_a', rootFolderId: ROOT, projectId: PA },
  { driveFolderId: 'folder_pb', rootFolderId: ROOT, projectId: PB },
  { driveFolderId: 'folder_item_b', rootFolderId: ROOT, projectId: PB },
];

function item(id: string, projectId: string): WorkItemRow {
  return {
    id,
    organizationId: ORG,
    projectId,
    audience: 'internal',
    state: 'triage',
    deletedAt: null,
    title: 'Item',
  } as unknown as WorkItemRow;
}

const PROJECT_FOLDERS: Record<string, readonly ProjectDriveFolder[]> = {
  [PA]: [
    { driveFolderId: 'folder_pa', kind: 'project', name: 'Project A', item: null },
    {
      driveFolderId: 'folder_item_a',
      kind: 'work_item',
      name: 'Item A',
      item: item(ITEM_A, PA),
    },
  ],
  [PB]: [
    { driveFolderId: 'folder_pb', kind: 'project', name: 'Project B', item: null },
    {
      driveFolderId: 'folder_item_b',
      kind: 'work_item',
      name: 'Item B',
      item: item(ITEM_B, PB),
    },
  ],
};

function ctx(): TenantContext {
  return {
    organizationId: ORG,
    userId: 'user-1',
    correlationId: 'c-1',
  } as unknown as TenantContext;
}

/** A member of project A only (project-scoped), or an org-wide owner/admin. */
function principal(role: string, hasOrgWideScope: boolean): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PA],
    hasOrgWideScope,
  } as unknown as Principal;
}
const MEMBER_A = principal('member', false);
const OWNER = principal('owner', true);
const ADMIN = principal('admin', true);

const database = {
  read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  transaction: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function fileIn(parents: readonly string[], id = FILE_ID): DriveFile {
  return {
    id,
    name: 'Plan.pdf',
    mimeType: 'application/pdf',
    size: 10,
    webViewLink: null,
    driveId: null,
    parents,
  };
}

function setup(options: { ancestors?: Record<string, readonly string[]>; file?: DriveFile } = {}) {
  const connection = {
    id: 'conn-1',
    organizationId: ORG,
    provider: 'google_drive',
    storageMode: 'google_drive',
    status: 'connected',
    accountEmail: 'owner@example.com',
    refreshTokenEnc: CIPHER.encrypt('rt', tokenBinding(ORG)),
    rootFolderId: ROOT,
    sharedDriveId: null,
    sharedDriveName: null,
    lastErrorCode: null,
  } as unknown as StorageConnectionRow;
  const repository = {
    findConnection: vi.fn(async () => connection),
    listProjectFolders: vi.fn(
      async (_r: unknown, _c: unknown, projectId: string) => PROJECT_FOLDERS[projectId] ?? [],
    ),
    findKnownFolders: vi.fn(async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      KNOWN.filter((folder) => ids.includes(folder.driveFolderId)),
    ),
    knownRootsAmong: vi.fn(async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      ids.filter((id) => id === ROOT),
    ),
    attachedItemsForFile: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    insertAttachment: vi.fn(async (_r: unknown, _c: unknown, input: Record<string, unknown>) => ({
      id: 'att-1',
      ...input,
      createdAt: new Date('2026-10-26T00:00:00Z'),
    })),
  };
  const file = options.file ?? fileIn([]);
  const ancestors = options.ancestors ?? {};
  const google = {
    exchangeCode: vi.fn(),
    refreshAccessToken: vi.fn(async () => 'company-wide-access-token'),
    revoke: vi.fn(),
    ensureFolder: vi.fn(),
    getFile: vi.fn(async (_t: string, id: string) =>
      id === file.id
        ? file
        : { ...fileIn(ancestors[id] ?? [], id), mimeType: FOLDER_MIME_TYPE, name: 'Folder' },
    ),
    listChildren: vi.fn(async () => ({
      files: [
        {
          id: 'child_file_1',
          name: 'Brief.pdf',
          mimeType: 'application/pdf',
          size: 5,
          modifiedTime: '2026-10-25T10:00:00.000Z',
          isFolder: false,
        },
      ],
      nextPageToken: null,
    })),
    startUpload: vi.fn(),
  } satisfies DriveTransport;
  const audit = { record: vi.fn(async () => ({})) };
  const drive = new GoogleDriveService({
    database,
    audit: audit as unknown as AuditService,
    transport: google,
    cipher: CIPHER,
    config: { clientId: 'cid', clientSecret: 'cs', pickerApiKey: 'k', projectNumber: '42' },
    apiPublicUrl: 'https://tmanage.example.com',
    webPublicUrl: 'https://tmanage.example.com',
    uploadMaxBytes: 1000,
    repository: repository as unknown as GoogleDriveRepository,
    workItems: {
      findById: vi.fn(async (_r: unknown, _c: unknown, id: string) =>
        id === ITEM_A ? item(ITEM_A, PA) : id === ITEM_B ? item(ITEM_B, PB) : null,
      ) as never,
    },
    projects: {
      findById: vi.fn(async (_r: unknown, _c: unknown, id: string) =>
        id === PA || id === PB ? ({ id, organizationId: ORG, archivedAt: null } as never) : null,
      ),
    },
  });
  return { drive, google, audit, repository };
}

describe('NV10: the company Drive token leaves the server only for an org-wide caller', () => {
  it('(i) a project-A member gets mode scoped, no accessToken key, and no token is minted', async () => {
    const { drive, google, audit } = setup();
    const view = await drive.pickerSession(ctx(), MEMBER_A, PA);
    expect(view).toEqual({ mode: 'scoped', projectId: PA });
    expect(Object.keys(view)).not.toContain('accessToken');
    expect(JSON.stringify(view)).not.toContain('company-wide-access-token');
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('(ii) a project-scoped member asking with no project gets 403 and no token', async () => {
    const { drive, google } = setup();
    await expect(drive.pickerSession(ctx(), MEMBER_A)).rejects.toMatchObject({ status: 403 });
    // A custom or built-in role with org-wide scope but no org.manage is refused as well.
    await expect(drive.pickerSession(ctx(), principal('member', true))).rejects.toMatchObject({
      status: 403,
    });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('the owner gets the Google picker with no project; an admin (no org.manage) does not', async () => {
    const { drive } = setup();
    await expect(drive.pickerSession(ctx(), ADMIN)).rejects.toMatchObject({ status: 403 });
    expect(await drive.pickerSession(ctx(), OWNER)).toMatchObject({
      mode: 'google',
      accessToken: 'company-wide-access-token',
      rootFolderId: ROOT,
    });
  });

  it('an org-wide manager naming a project gets the Google picker, audited with it', async () => {
    const { drive, audit } = setup();
    expect(await drive.pickerSession(ctx(), principal('manager', true), PB)).toMatchObject({
      mode: 'google',
      accessToken: 'company-wide-access-token',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect((audit.record.mock.calls[0] as unknown[])[2]).toMatchObject({
      action: 'drive_picker.session_issued',
      metadata: { project_id: PB },
    });
  });

  it('a project-A member cannot even get the scoped session for project B', async () => {
    const { drive } = setup();
    await expect(drive.pickerSession(ctx(), MEMBER_A, PB)).rejects.toMatchObject({ status: 403 });
  });
});

describe('NV10: the server-side project file list stays inside the project', () => {
  it("lists the project folder by default, with only this project's folders and no links", async () => {
    const { drive, google } = setup();
    const view = await drive.projectFiles(ctx(), MEMBER_A, PA, {});
    expect(view.folderId).toBe('folder_pa');
    expect(view.folders.map((folder) => folder.id)).toEqual(['folder_pa', 'folder_item_a']);
    expect(view.files).toEqual([
      {
        id: 'child_file_1',
        name: 'Brief.pdf',
        mimeType: 'application/pdf',
        size: 5,
        modifiedTime: '2026-10-25T10:00:00.000Z',
        isFolder: false,
      },
    ]);
    const body = JSON.stringify(view);
    expect(body).not.toMatch(/webContentLink|thumbnailLink|accessToken|company-wide-access-token/);
    expect(google.listChildren).toHaveBeenCalledWith('company-wide-access-token', {
      parentId: 'folder_pa',
      pageToken: null,
    });
  });

  it("(iii) project A with project B's folder is 404 and Google is never called", async () => {
    const { drive, google } = setup();
    await expect(
      drive.projectFiles(ctx(), MEMBER_A, PA, { folderId: 'folder_pb' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      drive.projectFiles(ctx(), MEMBER_A, PA, { folderId: 'folder_item_b' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
    expect(google.listChildren).not.toHaveBeenCalled();
    expect(google.getFile).not.toHaveBeenCalled();
  });

  it("refuses a project-A member listing project B's files with 403 before any lookup", async () => {
    const { drive, google, repository } = setup();
    await expect(drive.projectFiles(ctx(), MEMBER_A, PB, {})).rejects.toMatchObject({
      status: 403,
    });
    expect(repository.listProjectFolders).not.toHaveBeenCalled();
    expect(google.listChildren).not.toHaveBeenCalled();
  });

  it('answers an empty list without Google when the project has no folder yet', async () => {
    const { drive, google, repository } = setup();
    repository.listProjectFolders.mockResolvedValueOnce([]);
    expect(await drive.projectFiles(ctx(), MEMBER_A, PA, {})).toEqual({
      folderId: null,
      files: [],
      folders: [],
      nextPageToken: null,
    });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("(iv) listChildren's q names only the requested folder, built through the literal", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            files: [
              {
                id: 'child_file_1',
                name: 'a.pdf',
                mimeType: 'application/pdf',
                webContentLink: 'https://drive.google.com/uc?id=x',
                thumbnailLink: 'https://lh3.googleusercontent.com/x',
              },
            ],
            nextPageToken: 'next_page-1.~',
          }),
          { status: 200 },
        ),
    );
    const page = await createDriveTransport(fetchImpl as unknown as typeof fetch).listChildren(
      'at',
      { parentId: 'folder_pa', pageToken: null },
    );
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('q')).toBe("'folder_pa' in parents and trashed = false");
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(url.searchParams.get('fields')).toBe(
      'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)',
    );
    expect(JSON.stringify(page)).not.toMatch(/webContentLink|thumbnailLink/);
    expect(page.nextPageToken).toBe('next_page-1.~');
  });

  it('(iv) a quote in folderId, a bad project id or an oversized page token is a 400', async () => {
    const service = { projectFiles: vi.fn() };
    const controller = new GoogleDriveStorageController(service as never, {} as never);
    const call = (projectId: string, folderId?: unknown, pageToken?: unknown) =>
      controller.projectFiles(ctx(), MEMBER_A, projectId, folderId, pageToken);
    await expect(call(PA, "folder_pa' or 'folder_pb")).rejects.toMatchObject({ status: 400 });
    await expect(call(PA, "x' in parents or name contains '")).rejects.toMatchObject({
      status: 400,
    });
    await expect(call('not-a-uuid')).rejects.toMatchObject({ status: 400 });
    await expect(call(PA, undefined, 'a'.repeat(513))).rejects.toMatchObject({ status: 400 });
    await expect(call(PA, undefined, "tok'en")).rejects.toMatchObject({ status: 400 });
    expect(service.projectFiles).not.toHaveBeenCalled();
    await call(PA, 'folder_item_a', 'a'.repeat(512));
    expect(service.projectFiles).toHaveBeenCalledWith(ctx(), MEMBER_A, PA, {
      folderId: 'folder_item_a',
      pageToken: 'a'.repeat(512),
    });
  });
});

describe('M04: the attach check follows unknown parents up to a TManage folder', () => {
  it("(v) file -> unknown subfolder -> project B's folder is 404 on an A item", async () => {
    const { drive, repository } = setup({
      file: fileIn(['user_subfolder_1']),
      ancestors: { user_subfolder_1: ['folder_pb'] },
    });
    await expect(drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID)).rejects.toMatchObject({
      status: 404,
    });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
  });

  it("(v) file -> unknown subfolder -> project A's folder is attached", async () => {
    const { drive, repository, google } = setup({
      file: fileIn(['user_subfolder_1']),
      ancestors: { user_subfolder_1: ['folder_pa'] },
    });
    await drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID);
    expect(repository.insertAttachment).toHaveBeenCalledTimes(1);
    expect(google.getFile).toHaveBeenCalledWith(
      'company-wide-access-token',
      'user_subfolder_1',
      'parents',
    );
  });

  it('(v) a file in a subfolder of the bare TManage root is 404', async () => {
    const { drive, repository } = setup({
      file: fileIn(['user_subfolder_1']),
      ancestors: { user_subfolder_1: [ROOT] },
    });
    await expect(drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID)).rejects.toMatchObject({
      status: 404,
    });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
  });

  function chain(length: number, top: string): Record<string, readonly string[]> {
    const links: Record<string, string[]> = {};
    for (let index = 1; index <= length; index += 1) {
      links[`unknown_${index}`] = [index === length ? top : `unknown_${index + 1}`];
    }
    return links;
  }

  it('(v) a chain deeper than 8 hops is 404 even when it ends in the right folder', async () => {
    const { drive, repository } = setup({
      file: fileIn(['unknown_1']),
      ancestors: chain(9, 'folder_pa'),
    });
    await expect(drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID)).rejects.toMatchObject({
      status: 404,
    });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
  });

  it('a chain of exactly 8 hops to the right folder is attached', async () => {
    const { drive, repository } = setup({
      file: fileIn(['unknown_1']),
      ancestors: chain(8, 'folder_pa'),
    });
    await drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID);
    expect(repository.insertAttachment).toHaveBeenCalledTimes(1);
  });

  it("a person's own file under unknown folders with no TManage ancestor is still attached", async () => {
    const { drive, repository } = setup({
      file: fileIn(['my_folder_1']),
      ancestors: { my_folder_1: ['my_drive_top_1'] },
    });
    await drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID);
    expect(repository.insertAttachment).toHaveBeenCalledTimes(1);
  });

  it('a parent cycle ends the walk instead of looping', async () => {
    const { drive, google } = setup({
      file: fileIn(['loop_a_1']),
      ancestors: { loop_a_1: ['loop_b_1'], loop_b_1: ['loop_a_1'] },
    });
    await drive.attach(ctx(), MEMBER_A, ITEM_A, FILE_ID);
    expect(google.getFile.mock.calls.length).toBeLessThan(5);
  });
});
