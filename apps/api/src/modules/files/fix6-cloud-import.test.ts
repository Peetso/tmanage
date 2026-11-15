import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { DownloadTooLargeError, readCappedBody } from '../../common/storage/capped-body.js';
import { rethrowTooLarge } from '../../common/storage/cloud-fetch.js';
import {
  DriveNoAccessError,
  createDriveTransport,
  isGoogleNativeFormat,
} from '../google-drive/google-drive.google.js';
import {
  OneDriveRedirectRefusedError,
  createOneDriveTransport,
  isOneDriveContentUrl,
} from '../onedrive/onedrive.graph.js';
import { WorkItemFilesService } from '../work/item-files.service.js';
import { CloudImportService } from './cloud-import.service.js';
import { driveSource, oneDriveSource } from './cloud-import.controller.js';
import { FileClientRelation } from './file-client-relation.js';
import { FilesService, SERVER_IMPORT_UPLOAD_ID } from './files.service.js';

/**
 * FIX6 C1 — a picked Drive/OneDrive file stored as a checked TManage copy. Every test here fails
 * when the check it names is removed: the SSRF guard on Graph's redirect, the size cap while
 * reading, the file-safety rule and the internal-only door before anything is stored, the work
 * item's project gate before the drive is asked, and the portal's "only after Share" reach.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000f1';
const CLIENT_ORG = '00000000-0000-4000-8000-0000000000c9';
const SESSION = '00000000-0000-4000-8000-0000000000e9';
const context = { organizationId: ORG, userId: 'u-1' } as unknown as TenantContext;

const base = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
} as const;
function member(projectIds: readonly string[]): Principal {
  return {
    ...base,
    kind: 'internal',
    role: 'member',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  } as unknown as Principal;
}
const client = {
  ...base,
  kind: 'client',
  role: 'client_reviewer',
  clientOrganizationId: CLIENT_ORG,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
} as unknown as Principal;

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function streamed(chunks: readonly number[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('FIX6 C1 — the provider downloads', () => {
  it('follows a Graph redirect only to Microsoft storage, and never sends the token there', async () => {
    let target = 'https://tenant-my.sharepoint.com/personal/download.aspx?x=1';
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://graph.microsoft.com/')) {
        expect(init?.redirect).toBe('manual');
        return new Response(null, { status: 302, headers: { location: target } });
      }
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response('hello', { status: 200 });
    });
    const transport = createOneDriveTransport(fetchImpl as unknown as typeof fetch);
    const bytes = await transport.downloadItem(
      'secret-token',
      { driveId: 'b!drive', itemId: 'ITEM1' },
      100,
    );
    expect(bytes.toString()).toBe('hello');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://graph.microsoft.com/v1.0/drives/b!drive/items/ITEM1/content',
    );

    fetchImpl.mockClear();
    target = 'https://169.254.169.254/latest/meta-data';
    await expect(
      transport.downloadItem('secret-token', { driveId: 'b!drive', itemId: 'ITEM1' }, 100),
    ).rejects.toBeInstanceOf(OneDriveRedirectRefusedError);
    // The refused target is never asked for anything.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts only https Microsoft storage hosts as a redirect target', () => {
    expect(isOneDriveContentUrl('https://contoso.sharepoint.com/a')).toBe(true);
    expect(isOneDriveContentUrl('https://public.bn.files.1drv.com/y4m')).toBe(true);
    expect(isOneDriveContentUrl('http://contoso.sharepoint.com/a')).toBe(false);
    expect(isOneDriveContentUrl('https://contoso.sharepoint.com:8443/a')).toBe(false);
    expect(isOneDriveContentUrl('https://user:pw@contoso.sharepoint.com/a')).toBe(false);
    expect(isOneDriveContentUrl('https://sharepoint.com.evil.example/a')).toBe(false);
    expect(isOneDriveContentUrl('https://evilsharepoint.com/a')).toBe(false);
    expect(isOneDriveContentUrl(null)).toBe(false);
  });

  it('downloads a Drive file from the fixed host only, never following a redirect', async () => {
    const fetchImpl = vi.fn(async () => new Response('pdf', { status: 200 }));
    const bytes = await createDriveTransport(fetchImpl as unknown as typeof fetch).downloadFile(
      'at',
      'FILE_id-1',
      100,
    );
    expect(bytes.toString()).toBe('pdf');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://www.googleapis.com/drive/v3/files/FILE_id-1?alt=media&supportsAllDrives=true',
    );
    expect(init.redirect).toBe('error');
    const denied = vi.fn(async () => new Response('', { status: 403 }));
    await expect(
      createDriveTransport(denied as unknown as typeof fetch).downloadFile('at', 'FILE_id-1', 100),
    ).rejects.toBeInstanceOf(DriveNoAccessError);
    expect(isGoogleNativeFormat('application/vnd.google-apps.document')).toBe(true);
  });

  it('stops reading past the cap, with or without a declared size, and answers too_large', async () => {
    await expect(readCappedBody(streamed([60, 60]), 100)).rejects.toBeInstanceOf(
      DownloadTooLargeError,
    );
    const declared = new Response('x', { headers: { 'content-length': '5000' } });
    await expect(readCappedBody(declared, 100)).rejects.toBeInstanceOf(DownloadTooLargeError);
    expect((await readCappedBody(streamed([40, 60]), 100)).byteLength).toBe(100);
    const mapped = await refusal(
      Promise.reject(new DownloadTooLargeError('big')).catch(rethrowTooLarge),
    );
    expect([mapped.status, mapped.code, mapped.details]).toEqual([
      422,
      'file_not_allowed',
      [{ field: 'reason', message: 'too_large' }],
    ]);
  });

  it('takes provider ids only from the body, never a URL', () => {
    expect(() => driveSource({ fileId: 'https://evil.example/x' })).toThrow(ApiError);
    expect(() => oneDriveSource({ driveId: 'b!d', itemId: 'https://evil/x' })).toThrow(ApiError);
    expect(driveSource({ fileId: 'FILE_id-1' })).toEqual({
      provider: 'google_drive',
      fileId: 'FILE_id-1',
    });
  });
});

function importHarness() {
  const database = {
    read: (_c: unknown, run: (r: unknown) => unknown) => run({}),
    transaction: (_c: unknown, run: (r: unknown) => unknown) => run({}),
  };
  const session = {
    id: SESSION,
    fileAssetId: 'asset-1',
    objectKey: 'k',
    declaredBytes: 3,
    declaredMimeType: 'application/pdf',
    partCount: 1,
  };
  const sessions = {
    nextId: vi.fn(() => SESSION),
    create: vi.fn(async (..._args: unknown[]) => session),
    transition: vi.fn(async (..._args: unknown[]) => true),
  };
  const asset = {
    id: 'asset-1',
    name: 'brief.pdf',
    status: 'uploaded',
    purpose: 'deliverable',
    projectId: PROJECT,
    createdAt: new Date(),
    rejectionCode: null,
  };
  const version = {
    id: 'v-1',
    sizeBytes: 3,
    versionNo: 1,
    detectedMimeType: null,
    scanSource: 'none',
    scanVerdict: null,
    scanner: null,
    trustZone: 'quarantine',
  };
  const assets = {
    create: vi.fn(async () => asset),
    transition: vi.fn(async () => asset),
    createVersion: vi.fn(async () => version),
  };
  const counters = {
    ensure: vi.fn(async () => undefined),
    reserve: vi.fn(async () => true),
    commit: vi.fn(async () => true),
    release: vi.fn(async () => true),
  };
  const projects = { findById: vi.fn(async () => ({ id: PROJECT, archivedAt: null })) };
  const store = {
    putQuarantine: vi.fn(async (input: { body: Uint8Array }) => ({
      sizeBytes: input.body.byteLength,
      etag: 'e',
    })),
  };
  const audit = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const scanJob = { request: vi.fn() };
  const service = new FilesService(
    database as never,
    sessions as never,
    assets as never,
    counters as never,
    null,
    projects as never,
    {} as never,
    store as never,
    {
      uploadMaxBytes: 1_000,
      uploadPartSizeBytes: 5_242_880,
      uploadUrlTtlSeconds: 900,
      storageOrgBytesLimit: 1_000_000,
    } as never,
    audit as never,
    null,
    null,
    scanJob,
    null,
  );
  return { service, sessions, assets, counters, store, scanJob, projects };
}

const pdf = (name = 'brief.pdf') => ({
  projectId: PROJECT,
  fileName: name,
  mimeType: 'application/pdf',
  bytes: Buffer.from('%PD'),
  objectId: null,
});

describe('FIX6 C1 — FilesService.importFetched, the upload path for fetched bytes', () => {
  it('stores the copy through the upload commit, so the verifier and scanner pass run on it', async () => {
    const h = importHarness();
    const view = await h.service.importFetched(context, member([PROJECT]), pdf());
    expect(view.uploadSessionId).toBe(SESSION);
    expect(h.sessions.create.mock.calls[0]?.[2]).toMatchObject({
      providerUploadId: SERVER_IMPORT_UPLOAD_ID,
      uploadTargets: [],
      purpose: 'deliverable',
      declaredBytes: 3,
    });
    const moves = h.sessions.transition.mock.calls.map((call) => [call[3], call[4]]);
    expect(moves).toEqual([
      [['reserved'], 'completing'],
      [['completing'], 'completed'],
    ]);
    expect(h.store.putQuarantine).toHaveBeenCalledTimes(1);
    expect(h.counters.reserve).toHaveBeenCalledTimes(1);
    expect(h.scanJob.request).toHaveBeenCalledTimes(1);
  });

  it('refuses a blocked type before any byte is stored or any storage reserved', async () => {
    const h = importHarness();
    const error = await refusal(
      h.service.importFetched(context, member([PROJECT]), {
        ...pdf('setup.exe'),
        mimeType: 'application/x-msdownload',
      }),
    );
    expect([error.status, error.code]).toEqual([422, 'file_not_allowed']);
    expect(h.store.putQuarantine).not.toHaveBeenCalled();
    expect(h.counters.reserve).not.toHaveBeenCalled();
  });

  it('refuses a client principal before anything is read, fetched or stored', async () => {
    const h = importHarness();
    const error = await refusal(h.service.preflightImport(context, client, PROJECT));
    expect(error.status).toBe(403);
    await refusal(h.service.importFetched(context, client, pdf()));
    expect(h.projects.findById).not.toHaveBeenCalled();
    expect(h.store.putQuarantine).not.toHaveBeenCalled();
  });

  it('gives the reservation back when the bytes cannot be stored', async () => {
    const h = importHarness();
    h.store.putQuarantine.mockRejectedValueOnce(new Error('disk full'));
    await expect(h.service.importFetched(context, member([PROJECT]), pdf())).rejects.toThrow(
      'disk full',
    );
    expect(h.counters.release).toHaveBeenCalledTimes(1);
    expect(h.sessions.transition.mock.calls.at(-1)?.[4]).toBe('failed');
  });
});

function cloudHarness(principalProjects: readonly string[]) {
  const database = {
    read: (_c: unknown, run: (r: unknown) => unknown) => run({}),
    transaction: (_c: unknown, run: (r: unknown) => unknown) => run({}),
  };
  const workItems = {
    findById: vi.fn(async () => ({
      id: WORK_ITEM,
      organizationId: ORG,
      projectId: PROJECT,
      audience: 'internal',
      state: 'in_progress',
      deletedAt: null,
    })),
  };
  const links = {
    findByPair: vi.fn(async () => null),
    create: vi.fn(async () => ({
      id: 'link-1',
      workItemId: WORK_ITEM,
      fileAssetId: 'asset-1',
      attachedByMembershipId: base.membershipId,
      createdAt: new Date(),
    })),
  };
  const fileAssets = {
    findById: vi.fn(async () => ({
      id: 'asset-1',
      projectId: PROJECT,
      name: 'brief.pdf',
      status: 'uploaded',
      deletedAt: null,
    })),
  };
  const files = {
    preflightImport: vi.fn(async () => ({ maxBytes: 1_000 })),
    importFetched: vi.fn(async () => ({
      file: { id: 'asset-1' },
      uploadSessionId: 'sess-1',
    })),
  };
  const fetched = {
    provider: 'google_drive' as const,
    externalId: 'FILE_id-1',
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('%PD'),
  };
  const googleDrive = { fetchForImport: vi.fn(async (..._args: unknown[]) => fetched) };
  const oneDrive = { fetchForImport: vi.fn() };
  const audit = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const service = new CloudImportService({
    database: database as never,
    files: files as never,
    workItemFiles: new WorkItemFilesService(
      database as never,
      workItems as never,
      fileAssets as never,
      links as never,
    ),
    deliverables: { findById: vi.fn() } as never,
    googleDrive: googleDrive as never,
    oneDrive: oneDrive as never,
    audit: audit as never,
  });
  return { service, files, googleDrive, links, audit, principal: member(principalProjects) };
}

describe('FIX6 C1 — CloudImportService', () => {
  it('answers 404 to a member of another project, and never asks the drive', async () => {
    const h = cloudHarness([OTHER_PROJECT]);
    const error = await refusal(
      h.service.importToWorkItem(context, h.principal, WORK_ITEM, {
        provider: 'google_drive',
        fileId: 'FILE_id-1',
      }),
    );
    expect(error.status).toBe(404);
    expect(h.files.preflightImport).not.toHaveBeenCalled();
    expect(h.googleDrive.fetchForImport).not.toHaveBeenCalled();
  });

  it('fetches under the cap, attaches the copy and audits the provider without the raw id', async () => {
    const h = cloudHarness([PROJECT]);
    const view = await h.service.importToWorkItem(context, h.principal, WORK_ITEM, {
      provider: 'google_drive',
      fileId: 'FILE_id-1',
    });
    expect(h.googleDrive.fetchForImport.mock.calls[0]?.slice(2)).toEqual([
      PROJECT,
      'FILE_id-1',
      1_000,
    ]);
    expect(view.attachment.fileAssetId).toBe('asset-1');
    const event = h.audit.record.mock.calls[0]?.[2] as unknown as {
      action: string;
      metadata: Record<string, string>;
    };
    expect(event.action).toBe('work_item.drive_file_imported');
    expect(event.metadata['provider']).toBe('google_drive');
    expect(event.metadata['external_id_sha256']).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(event)).not.toContain('FILE_id-1');
  });
});

describe('FIX6 C1 — the portal reaches an imported deliverable copy only after Share', () => {
  const asset = {
    id: 'asset-1',
    organizationId: ORG,
    projectId: PROJECT,
    purpose: 'deliverable',
    objectId: '00000000-0000-4000-8000-0000000000d7',
    audience: 'internal',
    clientOrganizationId: null,
  } as never;

  it('is a 404 for the client until a shared version names the copy', async () => {
    const reach = {
      publishedVersionNaming: vi.fn(async () => null),
      deliverableIsPublished: vi.fn(async () => false),
      chainSiblings: vi.fn(async () => []),
      clientVisibleFolderProject: vi.fn(async () => null),
    };
    const relation = new FileClientRelation({} as never, reach as never);
    expect(await relation.mayClientReach({} as never, context, client, asset)).toBe(false);
    reach.publishedVersionNaming.mockResolvedValueOnce({ projectId: PROJECT } as never);
    expect(await relation.mayClientReach({} as never, context, client, asset)).toBe(true);
  });
});

describe('FIX6 C3b — a folder file opened as a checked copy', () => {
  it('reuses the copy while the modified time is unchanged, and refuses a blocked type', async () => {
    const h = importHarness();
    const folder = {
      id: 'cf-1',
      organizationId: ORG,
      projectId: PROJECT,
      workItemId: WORK_ITEM,
      provider: 'google_drive',
      externalDriveId: null,
      externalFolderId: 'FOLDER_1',
      removedAt: null,
    };
    const imports: Record<string, string> = {};
    const keyOf = (k: { externalItemId: string; modifiedTime: string }) =>
      `${k.externalItemId}@${k.modifiedTime}`;
    const child = (id: string) => ({
      id,
      name: id,
      mimeType: 'application/pdf',
      size: 3,
      modifiedTime: '2026-11-15T10:00:00Z',
      isFolder: false,
    });
    const drive = {
      inspectChild: vi.fn(async (_c: unknown, _r: unknown, id: string) => child(id)),
      fetchFromFolder: vi.fn(async (_c: unknown, _r: unknown, id: string) => ({
        provider: 'google_drive' as const,
        externalId: id,
        name: id,
        mimeType: id.endsWith('.exe') ? 'application/x-msdownload' : 'application/pdf',
        bytes: Buffer.from('%PD'),
      })),
    };
    const { CloudFoldersService } = await import('../cloud-folders/cloud-folders.service.js');
    const folders = new CloudFoldersService({
      database: {
        read: (_c: unknown, work: (r: unknown) => unknown) => work({}),
        transaction: (_c: unknown, work: (r: unknown) => unknown) => work({}),
      } as never,
      folders: {
        findLive: async () => folder,
        findImport: async (_r: unknown, _c: unknown, k: never) =>
          imports[keyOf(k)] ? { fileAssetId: imports[keyOf(k)] } : null,
        recordImport: async (
          _r: unknown,
          _c: unknown,
          k: never,
          input: { fileAssetId: string },
        ) => {
          imports[keyOf(k)] = input.fileAssetId;
        },
      } as never,
      workItems: {
        findById: async () =>
          ({
            ...folder,
            id: WORK_ITEM,
            audience: 'internal',
            state: 'open',
            deletedAt: null,
          }) as never,
      },
      drives: { google_drive: drive as never, onedrive: drive as never },
      files: h.service,
      assets: {
        findById: async () => ({ id: 'asset-1', projectId: PROJECT, deletedAt: null }) as never,
      },
      audit: null,
    });
    const owner = member([PROJECT]);
    const first = await folders.open(context, owner, WORK_ITEM, 'cf-1', 'brief_pdf1');
    const again = await folders.open(context, owner, WORK_ITEM, 'cf-1', 'brief_pdf1');
    expect([first.imported, again.imported, again.fileId]).toEqual([true, false, 'asset-1']);
    expect(drive.fetchFromFolder).toHaveBeenCalledTimes(1);
    expect(h.store.putQuarantine).toHaveBeenCalledTimes(1);

    const blocked = await refusal(folders.open(context, owner, WORK_ITEM, 'cf-1', 'setup.exe'));
    expect([blocked.status, blocked.code]).toEqual([422, 'file_not_allowed']);
    expect(h.store.putQuarantine).toHaveBeenCalledTimes(1);
  });
});
