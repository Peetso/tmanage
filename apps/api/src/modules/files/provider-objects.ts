import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ByteRange, ObjectStore, OpenedObject, TrustZone } from '@tmanage/storage';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { DownloadTooLargeError } from '../../common/storage/capped-body.js';
import type { FileVersionRow } from '../../common/database/schema.js';

/**
 * 57-13a. Files can live in the company's own Drive or OneDrive.
 *
 * `file_versions.storage_backend` says where a version's bytes are: `local` (TManage's object
 * store, `object_key`) or the connected provider (`provider_file_id` inside the connection
 * `storage_connection_id`, both written only by TManage). {@link VersionStore} is the one read
 * every server-side consumer uses (download, version history, preview), so a client or a portal
 * guest never needs a provider account. Fresh uploads are always `local` (the scanner and the
 * verifier read quarantine), and only a promoted, cleared version is ever moved (57-13b).
 *
 * Order on a provider read: the version's own organization must be the caller's, and the
 * provider service then re-reads its connection under the same tenant and requires the row's
 * connection id, before any provider call. Every provider failure (revoked grant, file deleted
 * in Drive, unreachable) is one {@link ProviderObjectUnavailableError}; there is no fallback to
 * another object. No token, session URL or provider id is ever put in an error message.
 */

export const STORAGE_BACKENDS = ['local', 'google_drive', 'onedrive'] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];
export type ProviderBackend = Exclude<StorageBackend, 'local'>;

export function isProviderBackend(value: string | undefined): value is ProviderBackend {
  return value === 'google_drive' || value === 'onedrive';
}

/** Where a provider-held version lives — always from our own row, never from a request. */
export interface ProviderObjectRef {
  readonly connectionId: string;
  readonly providerFileId: string;
}

export type ProviderObjectFailure = 'not_connected' | 'missing' | 'unavailable' | 'too_large';

export class ProviderObjectUnavailableError extends Error {
  constructor(public readonly reason: ProviderObjectFailure) {
    super('the file is held in connected storage that cannot be read right now');
    this.name = 'ProviderObjectUnavailableError';
  }
}

export class ProviderHashMismatchError extends Error {
  constructor() {
    super('the provider copy does not match the file');
    this.name = 'ProviderHashMismatchError';
  }
}

/**
 * Run one provider call and turn any failure into a calm {@link ProviderObjectUnavailableError}:
 * a 409 from the connection checks is `not_connected`, a 404 `missing`, a cap `too_large`.
 */
export async function providerCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProviderObjectUnavailableError) throw error;
    if (error instanceof DownloadTooLargeError)
      throw new ProviderObjectUnavailableError('too_large');
    if (error instanceof ApiError && error.status === 409) {
      throw new ProviderObjectUnavailableError('not_connected');
    }
    if (error instanceof ApiError && error.status === 404) {
      throw new ProviderObjectUnavailableError('missing');
    }
    throw new ProviderObjectUnavailableError('unavailable');
  }
}

/** A name both providers accept: no path or reserved characters, at most 200 characters. */
export function providerFileName(name: string): string {
  const clean = [...name]
    .map((char) => (char < ' ' || '\\/:*?"<>|#%'.includes(char) ? '_' : char))
    .join('')
    .trim()
    .slice(0, 200);
  return clean === '' ? 'file' : clean;
}

/** What Drive and OneDrive each implement over the organization's storage connection. */
export interface ProviderObjectSource {
  /** Upload into the connection's own TManage root folder. */
  put(
    context: TenantContext,
    input: { readonly name: string; readonly mimeType: string; readonly bytes: Buffer },
  ): Promise<ProviderObjectRef>;
  /** The bytes, read at most `maxBytes`; throws {@link ProviderObjectUnavailableError}. */
  read(context: TenantContext, ref: ProviderObjectRef, maxBytes: number): Promise<Buffer>;
  /** Best-effort removal of a copy TManage just made. */
  remove(context: TenantContext, ref: ProviderObjectRef): Promise<void>;
}

export type ProviderObjectSources = Partial<Record<ProviderBackend, ProviderObjectSource>>;

export type StoredVersion = Pick<
  FileVersionRow,
  | 'organizationId'
  | 'objectKey'
  | 'sizeBytes'
  | 'storageBackend'
  | 'providerFileId'
  | 'storageConnectionId'
>;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class VersionStore {
  constructor(
    private readonly store: Pick<ObjectStore, 'openObject'>,
    private readonly providers: ProviderObjectSources = {},
  ) {}

  /** Open one version wherever it lives; `zone` applies to local versions only. */
  async open(
    context: TenantContext,
    version: StoredVersion,
    zone: TrustZone,
    range?: ByteRange,
  ): Promise<OpenedObject> {
    // Anything that is not a provider backend is TManage's own store, as every row was before 0361.
    if (!isProviderBackend(version.storageBackend)) {
      return this.store.openObject({
        zone,
        objectKey: version.objectKey,
        ...(range ? { range } : {}),
      });
    }
    if (version.organizationId !== context.organizationId) {
      throw new ProviderObjectUnavailableError('missing');
    }
    const source = this.providers[version.storageBackend];
    if (
      source === undefined ||
      zone !== 'private' ||
      version.providerFileId === null ||
      version.storageConnectionId === null
    ) {
      throw new ProviderObjectUnavailableError('not_connected');
    }
    const bytes = await source.read(
      context,
      { connectionId: version.storageConnectionId, providerFileId: version.providerFileId },
      version.sizeBytes,
    );
    const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    return { sizeBytes: bytes.byteLength, stream: Readable.from([slice]) };
  }

  /**
   * Copy a version's bytes to `backend` and prove the copy: read it back and compare SHA-256.
   * A mismatch removes the provider copy and throws {@link ProviderHashMismatchError}; the local
   * object is never touched here (moving and deleting is 57-13b's job).
   */
  async copyToProvider(
    context: TenantContext,
    backend: ProviderBackend,
    input: { readonly name: string; readonly mimeType: string; readonly bytes: Buffer },
  ): Promise<ProviderObjectRef> {
    const source = this.providers[backend];
    if (source === undefined) throw new ProviderObjectUnavailableError('not_connected');
    const ref = await source.put(context, { ...input, name: providerFileName(input.name) });
    const echoed = await source.read(context, ref, input.bytes.byteLength);
    if (sha256(echoed) !== sha256(input.bytes)) {
      await source.remove(context, ref).catch(() => undefined);
      throw new ProviderHashMismatchError();
    }
    return ref;
  }
}
