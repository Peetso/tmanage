import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  StorageConnectionRow,
  WorkItemCloudFolderRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import type { DriveFile, DriveTransport } from '../google-drive/google-drive.google.js';
import type { GoogleDriveRepository } from '../google-drive/google-drive.repository.js';
import { GoogleDriveService, tokenBinding } from '../google-drive/google-drive.service.js';
import type { CloudFolderDrive } from './cloud-folder-drive.js';
import type { CloudFoldersRepository } from './cloud-folders.repository.js';
import { CloudFoldersService } from './cloud-folders.service.js';

/** FIX6 C3 — the server-side fences of a live folder. Fake drive and storage; no Google, no DB. */

const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x45).toString('base64url')}`));
const P1 = '01890000-0000-7000-8000-000000000201';
const ITEM = '01890000-0000-7000-8000-000000000301';
const ctx = (org: string) =>
  ({ organizationId: org, userId: 'user-1' }) as unknown as TenantContext;
const member = {
  userId: 'user-1',
  organizationId: 'org-a',
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [P1],
  hasOrgWideScope: true,
} as unknown as Principal;
const database = {
  read: (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  transaction: (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

// Drive tree: FOLDER > SUB > inside.pdf; OTHER > outside.pdf (not under FOLDER).
const PARENTS: Record<string, readonly string[]> = {
  folder_attached: ['my_root'],
  sub_folder_1: ['folder_attached'],
  inside_file1: ['sub_folder_1'],
  outside_fil1: ['other_folder'],
  other_folder: ['my_root'],
};
const driveFile = (id: string): DriveFile => ({
  id,
  name: `${id}.pdf`,
  mimeType: id.includes('folder') ? 'application/vnd.google-apps.folder' : 'application/pdf',
  size: 3,
  webViewLink: null,
  driveId: null,
  parents: PARENTS[id] ?? [],
});

function setup() {
  const transport = {
    refreshAccessToken: vi.fn(async () => 'access'),
    getFile: vi.fn(async (_t: string, id: string) => driveFile(id)),
    listChildren: vi.fn(async () => ({ files: [], nextPageToken: null })),
    downloadFile: vi.fn(async () => Buffer.from('pdf')),
  } as unknown as DriveTransport;
  const connection = {
    id: 'conn-1',
    status: 'connected',
    refreshTokenEnc: CIPHER.encrypt('rt', tokenBinding('org-a')),
    rootFolderId: 'tmanage_root',
  } as unknown as StorageConnectionRow;
  const drive = new GoogleDriveService({
    database,
    audit: null,
    transport,
    cipher: CIPHER,
    config: { clientId: 'c', clientSecret: 's', pickerApiKey: null, projectNumber: null },
    apiPublicUrl: 'https://tmanage.example.com',
    repository: {
      findConnection: async () => connection,
      findKnownFolders: async () => [],
      knownRootsAmong: async () => [],
      attachedItemsForFile: async () => [],
    } as unknown as GoogleDriveRepository,
    storageModes: { effective: async () => 'google_drive', switchTo: async () => undefined },
  } as unknown as ConstructorParameters<typeof GoogleDriveService>[0]);
  const rows: WorkItemCloudFolderRow[] = [];
  const live = (org: string, item: string, id?: string) =>
    rows.filter(
      (r) =>
        r.organizationId === org && r.workItemId === item && !r.removedAt && (!id || r.id === id),
    );
  const folders = {
    listForItem: async (_r: unknown, c: TenantContext, item: string) =>
      live(c.organizationId, item),
    findLive: async (_r: unknown, c: TenantContext, item: string, id: string) =>
      live(c.organizationId, item, id)[0] ?? null,
    insert: async (_r: unknown, _c: TenantContext, row: WorkItemCloudFolderRow) => rows.push(row),
    markRemoved: async (_r: unknown, c: TenantContext, id: string, at: Date) => {
      for (const r of rows)
        if (r.id === id && r.organizationId === c.organizationId) r.removedAt = at;
    },
  } as unknown as CloudFoldersRepository;
  const workItem = (org: string) =>
    ({
      id: ITEM,
      organizationId: org,
      projectId: P1,
      audience: 'client_visible',
      state: 'open',
      deletedAt: null,
    }) as unknown as WorkItemRow;
  const service = new CloudFoldersService({
    database,
    folders,
    workItems: { findById: async (_r: unknown, c: TenantContext) => workItem(c.organizationId) },
    drives: { google_drive: drive, onedrive: {} as CloudFolderDrive },
    files: {
      importMaxBytes: async () => 1_000,
      importForFolderRead: async () => ({ file: { id: 'copy-1' } }) as never,
    },
    assets: { findById: async () => null },
    audit: null,
  });
  return { service, transport };
}

const status = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: { status?: number }) => error.status,
  );

describe('FIX6 C3 — live cloud folders', () => {
  it('opens a child inside the folder, and refuses an id outside it before any download', async () => {
    const { service, transport } = setup();
    const folder = await service.attach(ctx('org-a'), member, ITEM, {
      provider: 'google_drive',
      folderId: 'folder_attached',
    });
    const opened = await service.open(ctx('org-a'), member, ITEM, folder.id, 'inside_file1');
    expect(opened.fileId).toBe('copy-1');
    expect(await status(service.open(ctx('org-a'), member, ITEM, folder.id, 'outside_fil1'))).toBe(
      404,
    );
    expect(transport.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("refuses another organization's folder, and a removed attachment", async () => {
    const { service } = setup();
    const folder = await service.attach(ctx('org-a'), member, ITEM, {
      provider: 'google_drive',
      folderId: 'folder_attached',
    });
    const otherOrg = { ...member, organizationId: 'org-b' } as unknown as Principal;
    expect(
      await status(service.open(ctx('org-b'), otherOrg, ITEM, folder.id, 'inside_file1')),
    ).toBe(404);
    await service.remove(ctx('org-a'), member, ITEM, folder.id);
    expect(await status(service.open(ctx('org-a'), member, ITEM, folder.id, 'inside_file1'))).toBe(
      404,
    );
    expect(await service.list(ctx('org-a'), member, ITEM)).toEqual([]);
  });
});
