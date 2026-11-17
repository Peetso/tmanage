import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import {
  ProviderHashMismatchError,
  ProviderObjectUnavailableError,
  VersionStore,
  providerCall,
  providerFileName,
  type ProviderObjectSource,
  type StoredVersion,
} from './provider-objects.js';

const CONTEXT = { organizationId: 'org-a' } as TenantContext;
const BYTES = Buffer.from('hello provider');
const REF = { connectionId: 'conn-1', providerFileId: 'drive-file-1' };

function source(overrides: Partial<ProviderObjectSource> = {}): ProviderObjectSource {
  return {
    put: vi.fn(async () => REF),
    read: vi.fn(async () => BYTES),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}
const store = { openObject: vi.fn() } as unknown as ObjectStore;
const held = (patch: Partial<StoredVersion> = {}): StoredVersion => ({
  organizationId: 'org-a',
  objectKey: 'k',
  sizeBytes: BYTES.byteLength,
  storageBackend: 'google_drive',
  providerFileId: REF.providerFileId,
  storageConnectionId: REF.connectionId,
  ...patch,
});

async function text(opened: { stream: NodeJS.ReadableStream }): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of opened.stream) parts.push(Buffer.from(part as Uint8Array));
  return Buffer.concat(parts).toString();
}

describe('VersionStore (57-13a)', () => {
  it('reads a provider-held version through the connection, with the row ids', async () => {
    const drive = source();
    const opened = await new VersionStore(store, { google_drive: drive }).open(
      CONTEXT,
      held(),
      'private',
      { start: 6, end: 13 },
    );
    expect(await text(opened)).toBe('provider');
    expect(drive.read).toHaveBeenCalledWith(CONTEXT, REF, BYTES.byteLength);
  });

  it('never asks the provider for a version of another organization', async () => {
    const drive = source();
    const open = new VersionStore(store, { google_drive: drive }).open(
      CONTEXT,
      held({ organizationId: 'org-b' }),
      'private',
    );
    await expect(open).rejects.toBeInstanceOf(ProviderObjectUnavailableError);
    expect(drive.read).not.toHaveBeenCalled();
  });

  it('keeps local versions on the object store', async () => {
    const local = { openObject: vi.fn(async () => ({ sizeBytes: 1, stream: null })) };
    await new VersionStore(local as unknown as ObjectStore, { google_drive: source() }).open(
      CONTEXT,
      held({ storageBackend: 'local' }),
      'quarantine',
    );
    expect(local.openObject).toHaveBeenCalledWith({ zone: 'quarantine', objectKey: 'k' });
  });

  it('rejects a copy whose read-back hash differs and removes it', async () => {
    const drive = source({ read: vi.fn(async () => Buffer.from('tampered bytes')) });
    const copy = new VersionStore(store, { google_drive: drive }).copyToProvider(
      CONTEXT,
      'google_drive',
      { name: 'a/b.pdf', mimeType: 'application/pdf', bytes: BYTES },
    );
    await expect(copy).rejects.toBeInstanceOf(ProviderHashMismatchError);
    expect(drive.remove).toHaveBeenCalledWith(CONTEXT, REF);
    expect(drive.put).toHaveBeenCalledWith(CONTEXT, expect.objectContaining({ name: 'a_b.pdf' }));
  });

  it('turns every provider failure into one calm typed error', async () => {
    const gone = providerCall(() => Promise.reject(new ApiError(404, 'not_found', 'x')));
    await expect(gone).rejects.toMatchObject({ reason: 'missing' });
    const down = providerCall(() => Promise.reject(new Error('socket')));
    await expect(down).rejects.toMatchObject({ reason: 'unavailable' });
    expect(providerFileName('  ')).toBe('file');
  });
});
