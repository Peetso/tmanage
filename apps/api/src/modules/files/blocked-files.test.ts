import { describe, expect, it, vi } from 'vitest';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  BlockedFilesController,
  fileExtension,
  isPurgeableBlocked,
  toBlockedFileView,
} from './blocked-files.controller.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { FilesService } from './files.service.js';

const ID = '0190a000-0000-7000-8000-0000000000aa';
const AT = new Date('2026-11-07T09:00:00.000Z');
const context = { organizationId: 'org', correlationId: 'c' } as unknown as TenantContext;
const asset = {
  ...{ id: ID, status: 'rejected', purgedAt: null, deletedAt: null },
} as unknown as FileAssetRow;
const version = { id: 'v1', trustZone: 'quarantine' } as unknown as FileVersionRow;

function controller(found: { asset: FileAssetRow; version: FileVersionRow | null } | null) {
  const database = {
    read: (_c: TenantContext, work: (runner: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const assets = {
    findWithLatestVersion: () => Promise.resolve(found),
  } as unknown as FileAssetsRepository;
  const purge = vi.fn(() => Promise.resolve({ purged: true, counterMoved: true }));
  const files = { purge } as unknown as FilesService;
  return { route: new BlockedFilesController(database, assets, files), purge };
}

describe('56-06 blocked files', () => {
  it('projects a row to metadata only, with the extension and the reason code', () => {
    const view = toBlockedFileView({
      ...{ id: ID, name: 'invoice.pdf.exe', rejectionCode: 'malware_detected', updatedAt: AT },
      ...{ declaredMimeType: 'application/pdf', detectedMimeType: null, sizeBytes: 10 },
      uploaderName: 'Sara Ali',
    });
    expect(view).toMatchObject({ extension: 'EXE', reason: 'malware_detected' });
    expect(view.blockedAt).toBe(AT.toISOString());
    expect(JSON.stringify(view)).not.toMatch(/objectKey|object_key/u);
    expect(fileExtension('.env')).toBe('');
    expect(fileExtension('README')).toBe('');
  });

  it('only a refused, unpurged, quarantined file can be deleted by hand', () => {
    expect(isPurgeableBlocked(asset, version)).toBe(true);
    expect(isPurgeableBlocked({ ...asset, status: 'ready' }, version)).toBe(false);
    expect(isPurgeableBlocked({ ...asset, purgedAt: AT }, version)).toBe(false);
    expect(isPurgeableBlocked(asset, { ...version, trustZone: 'private' })).toBe(false);
    expect(isPurgeableBlocked(asset, null)).toBe(false);
  });

  it('delete now purges through FilesService; anything else is a 404', async () => {
    const ok = controller({ asset, version });
    await ok.route.remove(context, ID);
    expect(ok.purge).toHaveBeenCalledWith(context, asset, version);

    const ready = controller({ asset: { ...asset, status: 'ready' }, version });
    await expect(ready.route.remove(context, ID)).rejects.toMatchObject({ status: 404 });
    expect(ready.purge).not.toHaveBeenCalled();
    await expect(controller(null).route.remove(context, ID)).rejects.toMatchObject({
      status: 404,
    });
    await expect(ok.route.remove(context, 'not-an-id')).rejects.toMatchObject({ status: 404 });
  });
});
