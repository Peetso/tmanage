import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageConnectionRow, WorkItemRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import {
  createDriveTransport,
  type DriveFile,
  type DriveTransport,
} from './google-drive.google.js';
import type {
  AttachedItem,
  GoogleDriveRepository,
  KnownDriveFolder,
} from './google-drive.repository.js';
import { GoogleDriveService, tokenBinding } from './google-drive.service.js';

/**
 * Wave 10 R9 — V2 (attach stores another project's Drive file details) and NV10 (the picker token
 * is the company-wide `drive.file` token). Fake transport and repository; no database, no Google.
 */

const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x44).toString('base64url')}`));
const ORG = 'org-a';
const P1 = '01890000-0000-7000-8000-000000000201';
const P2 = '01890000-0000-7000-8000-000000000202';
const ITEM_P1 = '01890000-0000-7000-8000-000000000301';
const ITEM_P2 = '01890000-0000-7000-8000-000000000302';
const ROOT = 'root_folder_1';

const FOLDERS: readonly KnownDriveFolder[] = [
  { driveFolderId: 'folder_p1', rootFolderId: ROOT, projectId: P1 },
  { driveFolderId: 'folder_item_p1', rootFolderId: ROOT, projectId: P1 },
  { driveFolderId: 'folder_p2', rootFolderId: ROOT, projectId: P2 },
];

function ctx(): TenantContext {
  return {
    organizationId: ORG,
    userId: 'user-1',
    correlationId: 'c-1',
  } as unknown as TenantContext;
}

function principal(role: string, extra: Partial<Record<string, unknown>> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [P1],
    hasOrgWideScope: false,
    ...extra,
  } as unknown as Principal;
}

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

const database = {
  read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  transaction: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function setup(options: { attachedTo?: readonly AttachedItem[]; pickerApiKey?: string } = {}) {
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
    findKnownFolders: vi.fn(async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      FOLDERS.filter((folder) => ids.includes(folder.driveFolderId)),
    ),
    knownRootsAmong: vi.fn(async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      ids.filter((id) => id === ROOT),
    ),
    attachedItemsForFile: vi.fn(async () => options.attachedTo ?? []),
    listAttachments: vi.fn(async () => []),
    insertAttachment: vi.fn(async (_r: unknown, _c: unknown, input: Record<string, unknown>) => ({
      id: 'att-1',
      ...input,
      createdAt: new Date('2026-10-26T00:00:00Z'),
    })),
  };
  let file: DriveFile = fileIn([]);
  const google: DriveTransport = {
    exchangeCode: vi.fn(),
    refreshAccessToken: vi.fn(async () => 'fresh-access-token-value'),
    revoke: vi.fn(),
    ensureFolder: vi.fn(),
    getFile: vi.fn(async () => file),
    startUpload: vi.fn(),
  };
  const audit = { record: vi.fn(async () => ({})) };
  const drive = new GoogleDriveService({
    database,
    audit: audit as unknown as AuditService,
    transport: google,
    cipher: CIPHER,
    config: {
      clientId: 'cid',
      clientSecret: 'cs',
      pickerApiKey: options.pickerApiKey ?? null,
      projectNumber: null,
    },
    apiPublicUrl: 'https://tmanage.example.com',
    webPublicUrl: 'https://tmanage.example.com',
    uploadMaxBytes: 1000,
    repository: repository as unknown as GoogleDriveRepository,
    workItems: {
      findById: vi.fn(async (_r: unknown, _c: unknown, id: string) =>
        id === ITEM_P1 ? item(ITEM_P1, P1) : id === ITEM_P2 ? item(ITEM_P2, P2) : null,
      ) as never,
    },
    projects: {
      findById: vi.fn(async (_r: unknown, _c: unknown, id: string) =>
        id === P1 || id === P2 ? ({ id, organizationId: ORG, archivedAt: null } as never) : null,
      ),
    },
  });
  return {
    drive,
    google,
    audit,
    repository,
    useFile: (next: DriveFile) => {
      file = next;
    },
  };
}

function fileIn(parents: readonly string[]): DriveFile {
  return {
    id: 'file_abcdef12345',
    name: 'Secret plan.pdf',
    mimeType: 'application/pdf',
    size: 1234,
    webViewLink: 'https://drive.google.com/file/d/file_abcdef12345/view',
    driveId: null,
    parents,
  };
}

describe("V2: attach links only a file from this project's folders or a person's own file", () => {
  it("refuses a file inside another project's TManage folder with 404 and stores nothing", async () => {
    const { drive, useFile, repository, audit } = setup();
    useFile(fileIn(['folder_p2']));
    await expect(
      drive.attach(ctx(), principal('member'), ITEM_P1, 'file_abcdef12345'),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a file sitting directly in the TManage root (no project) with the same 404', async () => {
    const { drive, useFile, repository } = setup();
    useFile(fileIn([ROOT]));
    await expect(
      drive.attach(ctx(), principal('member'), ITEM_P1, 'file_abcdef12345'),
    ).rejects.toMatchObject({ status: 404 });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
  });

  it("attaches a file uploaded into the destination project's work-item folder", async () => {
    const { drive, useFile, repository } = setup();
    useFile(fileIn(['folder_item_p1']));
    const view = await drive.attach(ctx(), principal('member'), ITEM_P1, 'file_abcdef12345');
    expect(view).toMatchObject({ workItemId: ITEM_P1, driveFileId: 'file_abcdef12345' });
    expect(repository.insertAttachment).toHaveBeenCalledTimes(1);
  });

  it("attaches a person's own picked file outside the TManage root", async () => {
    const { drive, useFile, repository } = setup();
    useFile(fileIn(['my_own_folder_9']));
    await drive.attach(ctx(), principal('member'), ITEM_P1, 'file_abcdef12345');
    expect(repository.insertAttachment).toHaveBeenCalledTimes(1);
  });

  it('refuses a personal file already attached only in a project the caller cannot read', async () => {
    const { drive, useFile, repository } = setup({ attachedTo: [item(ITEM_P2, P2)] });
    useFile(fileIn(['my_own_folder_9']));
    await expect(
      drive.attach(ctx(), principal('member'), ITEM_P1, 'file_abcdef12345'),
    ).rejects.toMatchObject({ status: 404 });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
  });

  it('refuses a file whose parent is only reported as hidden but is linked in P2', async () => {
    const { drive, useFile, repository } = setup({ attachedTo: [item(ITEM_P2, P2)] });
    useFile(fileIn([]));
    await expect(
      drive.attach(ctx(), principal('member'), ITEM_P1, 'file_abcdef12345'),
    ).rejects.toMatchObject({ status: 404 });
    expect(repository.insertAttachment).not.toHaveBeenCalled();
  });

  it('the transport asks Google for the parents and returns them', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'f_12345', name: 'a', mimeType: 'text/plain', parents: ['p_1'] }),
          { status: 200 },
        ),
    );
    const file = await createDriveTransport(fetchImpl as unknown as typeof fetch).getFile(
      'at',
      'f_12345',
    );
    expect(file.parents).toEqual(['p_1']);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('parents');
  });
});

describe('NV10: each picker session is audited; guests and clients never get a token', () => {
  it('writes one drive_picker.session_issued row with the project id and no token', async () => {
    const { drive, audit } = setup({ pickerApiKey: 'k' });
    const view = await drive.pickerSession(ctx(), principal('member'), P1);
    expect(view.accessToken).toBe('fresh-access-token-value');
    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = (audit.record.mock.calls[0] as unknown[])[2];
    expect(entry).toMatchObject({
      action: 'drive_picker.session_issued',
      result: 'allowed',
      objectId: 'conn-1',
      metadata: { provider: 'google_drive', project_id: P1 },
    });
    expect(JSON.stringify(entry)).not.toContain('fresh-access-token-value');
  });

  it('refuses a guest and a client with 403 before any token is minted or audited', async () => {
    const { drive, google, audit } = setup({ pickerApiKey: 'k' });
    await expect(drive.pickerSession(ctx(), principal('guest'), P1)).rejects.toMatchObject({
      status: 403,
    });
    const client = principal('client_member', { kind: 'client', clientOrganizationId: 'c-1' });
    await expect(drive.pickerSession(ctx(), client, P1)).rejects.toMatchObject({ status: 403 });
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
