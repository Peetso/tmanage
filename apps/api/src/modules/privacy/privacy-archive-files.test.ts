import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import type { FileVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  ArchiveFileContents,
  MAX_FILE_BYTES,
  decideFile,
} from './privacy-archive-files.repository.js';
import { PrivacyArchiveBuilder } from './privacy-archive.repository.js';
import type { ArchiveHeader } from './privacy-archive.repository.js';

/**
 * H3 (audit gap 3) — file bytes in a data export, under the download route's scan policy. Fakes
 * only: a scripted database answer and an in-memory object store.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

function version(overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    id: 'v1',
    organizationId: ORG,
    fileAssetId: 'f1',
    versionNo: 1,
    objectKey: `tenant/${ORG}/project/p/upload/u1/object`,
    sizeBytes: 5,
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    contentHash: null,
    scanVerdict: 'clean',
    scannedAt: null,
    scanner: null,
    trustZone: 'private',
    etag: null,
    createdAt: new Date(0),
    ...overrides,
  } as FileVersionRow;
}

describe('Export file bytes — the scan policy', () => {
  it('includes a cleared file from the private zone', () => {
    expect(decideFile('ready', version(), 'block')).toEqual({
      include: true,
      zone: 'private',
      scanStatus: 'clean',
    });
  });

  it('includes a file still waiting for its scan, labelled, unless the owner blocks that', () => {
    const waiting = version({ scanVerdict: null, trustZone: 'quarantine' });
    expect(decideFile('scanning', waiting, 'allow_labeled')).toEqual({
      include: true,
      zone: 'quarantine',
      scanStatus: 'not_scanned',
    });
    expect(decideFile('scanning', waiting, 'block')).toEqual({
      include: false,
      reason: 'waiting_for_scan',
    });
  });

  it('never includes an infected, rejected or unverified file', () => {
    const infected = version({ scanVerdict: 'infected', trustZone: 'quarantine' });
    expect(decideFile('rejected', infected, 'allow_labeled')).toEqual({
      include: false,
      reason: 'blocked_by_scan',
    });
    const unverified = version({ scanVerdict: null, detectedMimeType: null });
    expect(decideFile('uploading', unverified, 'allow_labeled')).toEqual({
      include: false,
      reason: 'not_ready',
    });
    expect(decideFile('ready', undefined, 'allow_labeled')).toEqual({
      include: false,
      reason: 'not_ready',
    });
  });
});

function fakeDatabase(
  assets: readonly Record<string, unknown>[],
  versions: readonly FileVersionRow[],
) {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const runner = {
    query: (sql: string, params: readonly unknown[]) => {
      statements.push({ sql, params });
      return Promise.resolve(params[1] === '' ? assets : []);
    },
  };
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => {
      // The drizzle read of versions goes through a runner too; answer it from the fixture.
      const drizzleRunner = {
        ...runner,
        execute: () => Promise.resolve([versions.map((v) => ({ ...v }))]),
      };
      return fn(drizzleRunner);
    },
  } as unknown as TenantDatabase;
  return { database, statements };
}

describe('Export file bytes — reading them', () => {
  it('carries the bytes of a servable file and the reason for one left out', async () => {
    const reader = new ArchiveFileContents(
      {} as TenantDatabase,
      {
        openObject: () =>
          Promise.resolve({ sizeBytes: 5, stream: Readable.from([Buffer.from('hello')]) }),
      } as unknown as Pick<ObjectStore, 'openObject'>,
      undefined,
      () => Promise.resolve('allow_labeled'),
    );
    const read = reader as unknown as {
      oneFile: (
        context: TenantContext,
        asset: { id: string; name: string; status: string },
        v: FileVersionRow | undefined,
        d: ReturnType<typeof decideFile>,
        budget: number,
      ) => Promise<Record<string, unknown>>;
    };
    const included = await read.oneFile(
      context,
      { id: 'f1', name: 'brief.pdf', status: 'ready' },
      version(),
      decideFile('ready', version(), 'allow_labeled'),
      1_000,
    );
    expect(included).toMatchObject({
      file_id: 'f1',
      included: true,
      scan_status: 'clean',
      content_base64: Buffer.from('hello').toString('base64'),
    });
    const tooLarge = version({ sizeBytes: MAX_FILE_BYTES + 1 });
    expect(
      await read.oneFile(
        context,
        { id: 'f2', name: 'big.mov', status: 'ready' },
        tooLarge,
        decideFile('ready', tooLarge, 'allow_labeled'),
        Number.MAX_SAFE_INTEGER,
      ),
    ).toMatchObject({ included: false, left_out: 'too_large' });
    expect(
      await read.oneFile(
        context,
        { id: 'f3', name: 'a.pdf', status: 'ready' },
        version(),
        decideFile('ready', version(), 'allow_labeled'),
        4,
      ),
    ).toMatchObject({ included: false, left_out: 'archive_size_limit' });
  });

  it('lists a stored object that is gone as missing, not as an error', async () => {
    const reader = new ArchiveFileContents(
      {} as TenantDatabase,
      {
        openObject: () => Promise.reject(new ObjectNotFoundError()),
      } as unknown as Pick<ObjectStore, 'openObject'>,
      undefined,
      () => Promise.resolve('allow_labeled'),
    );
    const row = await (
      reader as unknown as {
        oneFile: (...args: unknown[]) => Promise<Record<string, unknown>>;
      }
    ).oneFile(
      context,
      { id: 'f1', name: 'x', status: 'ready' },
      version(),
      decideFile('ready', version(), 'block'),
      100,
    );
    expect(row).toMatchObject({ included: false, left_out: 'missing' });
  });

  it('57-13b: exports a version held in the company Drive through the provider, not the local store', async () => {
    const reads: unknown[] = [];
    const reader = new ArchiveFileContents(
      {} as TenantDatabase,
      {
        openObject: () => Promise.reject(new Error('the local store must not be read')),
      } as unknown as Pick<ObjectStore, 'openObject'>,
      undefined,
      () => Promise.resolve('allow_labeled'),
      {
        google_drive: {
          put: () => Promise.reject(new Error('not used')),
          remove: () => Promise.reject(new Error('not used')),
          read: (_context, ref) => {
            reads.push(ref);
            return Promise.resolve(Buffer.from('drive'));
          },
        },
      },
    );
    const held = version({
      storageBackend: 'google_drive',
      providerFileId: 'drive-file-1',
      storageConnectionId: 'connection-1',
    } as Partial<FileVersionRow>);
    const read = reader as unknown as {
      oneFile: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    const row = await read.oneFile(
      context,
      { id: 'f1', name: 'brief.pdf', status: 'ready' },
      held,
      decideFile('ready', held, 'allow_labeled'),
      1_000,
    );
    expect(row).toMatchObject({
      included: true,
      content_base64: Buffer.from('drive').toString('base64'),
    });
    expect(reads).toEqual([{ connectionId: 'connection-1', providerFileId: 'drive-file-1' }]);

    const unreachable = new ArchiveFileContents(
      {} as TenantDatabase,
      {} as Pick<ObjectStore, 'openObject'>,
      undefined,
      () => Promise.resolve('allow_labeled'),
      {},
    ) as unknown as typeof read;
    expect(
      await unreachable.oneFile(
        context,
        { id: 'f1', name: 'brief.pdf', status: 'ready' },
        held,
        decideFile('ready', held, 'allow_labeled'),
        1_000,
      ),
    ).toMatchObject({ included: false, left_out: 'storage_unavailable' });
  });

  it('narrows a member export to the files that person added, scoped to the organization', async () => {
    const { database, statements } = fakeDatabase([], []);
    const reader = new ArchiveFileContents(
      database,
      {} as Pick<ObjectStore, 'openObject'>,
      undefined,
      () => Promise.resolve('allow_labeled'),
    );
    expect(await reader.read(context, OWNER)).toEqual([]);
    expect(statements[0]?.sql).toContain('organization_id = ?');
    expect(statements[0]?.sql).toContain('owner_user_id = ?');
    expect(statements[0]?.params).toEqual([ORG, '', OWNER]);
  });
});

describe('Export archive — the file_contents section', () => {
  const header: ArchiveHeader = {
    format: 'tmanage-data-export',
    formatVersion: 1,
    kind: 'member',
    organization: { id: ORG, name: 'Northstar Studio' },
    subjectUserId: OWNER,
    generatedAt: new Date(0).toISOString(),
  };

  it("adds the subject's files with their bytes to a member export", async () => {
    const database = {
      read: () => Promise.resolve([]),
      identityRead: () => Promise.resolve({ account: [], signIns: [] }),
    } as unknown as TenantDatabase;
    const owners: (string | null)[] = [];
    const builder = new PrivacyArchiveBuilder(database, {
      read: (_c, owner) => {
        owners.push(owner);
        return Promise.resolve([
          {
            file_id: 'f1',
            name: 'brief.pdf',
            file_version_id: 'v1',
            version_no: 1,
            mime_type: 'application/pdf',
            size_bytes: 5,
            included: true,
            scan_status: 'clean',
            content_base64: 'aGVsbG8=',
          },
        ]);
      },
    });
    const document = await builder.build(context, header, () => Promise.resolve());
    expect(owners).toEqual([OWNER]);
    expect(document.sections['file_contents']).toEqual([
      expect.objectContaining({ file_id: 'f1', content_base64: 'aGVsbG8=' }),
    ]);
  });
});
