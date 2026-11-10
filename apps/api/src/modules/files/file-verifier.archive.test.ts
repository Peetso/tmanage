import { FakeObjectStore } from '@tmanage/storage';
import { describe, expect, it } from 'vitest';
import type {
  FileAssetRow,
  FileVersionRow,
  UploadSessionRow,
} from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import {
  displayEntryPath,
  inspectStoredArchive,
  judgeArchiveDirectory,
} from './archive-inspection.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileVerifier } from './file-verifier.js';
import { FilesService } from './files.service.js';
import { readZipDirectory } from './preview-generators/zip-reader.js';
import type { UploadSessionsRepository } from './upload-sessions.repository.js';

/**
 * Security review FIX5 M2 and L3. A ZIP (and an OOXML document, which is one) is refused by the
 * verifier for what its central directory holds: a program, a script, a macro document, a
 * disguised name, `vbaProject.bin`, an archive inside it, and — from the client door — an
 * encrypted entry. The refusal names the entry. Member and client uploads run the same pass.
 */

interface ZipMember {
  readonly name: string;
  readonly data?: string;
  readonly encrypted?: boolean;
}

/** A tiny stored (method 0) ZIP: local headers, data, the central directory, the end record. */
function zip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const data = Buffer.from(member.data ?? 'x', 'utf8');
    const flags = 0x0800 | (member.encrypted ? 0x0001 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const ZIP = 'application/zip';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ORG = '01900000-0000-7000-8000-000000000001';
const CLIENT_ORG = '01900000-0000-7000-8000-0000000000c1';

interface Harness {
  readonly verifier: FileVerifier;
  readonly asset: { status: string; rejectionCode: string | null };
  readonly audits: Record<string, unknown>[];
}

function harness(bytes: Buffer, declaredMimeType: string, door: 'member' | 'client'): Harness {
  const store = new FakeObjectStore(() => 0);
  const objectKey = 'org/asset/v1';
  store.objects.set(`quarantine/${objectKey}`, bytes);

  const asset = { status: 'uploaded', rejectionCode: null as string | null };
  const row = {
    id: 'fa-1',
    organizationId: ORG,
    projectId: 'p-1',
    purpose: 'project_file',
    objectId: null,
    get status() {
      return asset.status;
    },
  } as unknown as FileAssetRow;
  const version = {
    id: 'fv-1',
    fileAssetId: 'fa-1',
    objectKey,
    sizeBytes: bytes.length,
    declaredMimeType,
    contentHash: null,
  } as unknown as FileVersionRow;
  const session = {
    id: 'us-1',
    declaredContentHash: null,
    clientOrganizationId: door === 'client' ? CLIENT_ORG : null,
  } as unknown as UploadSessionRow;

  let listed = false;
  const assets = {
    organizationsAwaitingVerification: async () => [ORG],
    listAwaitingVerification: async () => {
      if (listed) return [];
      listed = true;
      return [row];
    },
    transition: async (
      _tx: unknown,
      _context: unknown,
      _id: string,
      to: string,
      facts?: { rejectionCode?: string },
    ) => {
      asset.status = to;
      if (facts?.rejectionCode) asset.rejectionCode = facts.rejectionCode;
    },
    findLatestVersion: async () => version,
    recordVerification: async () => true,
    findVersionById: async () => version,
  } as unknown as FileAssetsRepository;
  const sessions = {
    findCompletedForAsset: async () => session,
  } as unknown as UploadSessionsRepository;
  const database = {
    bootstrapRead: async (_options: unknown, run: (db: unknown) => unknown) => run({}),
    read: async (_context: unknown, run: (db: unknown) => unknown) => run({}),
    transaction: async (_context: unknown, run: (tx: unknown) => unknown) => run({}),
  } as unknown as TenantDatabase;
  const audits: Record<string, unknown>[] = [];
  const audit = {
    record: async (_tx: unknown, _context: unknown, event: Record<string, unknown>) => {
      audits.push(event);
    },
  } as unknown as AuditService;
  const outbox = { append: async () => undefined } as unknown as OutboxEventsRepository;
  const verifier = new FileVerifier(database, assets, sessions, store, audit, outbox);
  return { verifier, asset, audits };
}

async function verdict(
  bytes: Buffer,
  door: 'member' | 'client' = 'member',
  declared: string = ZIP,
): Promise<{ status: string; code: string | null; kind: unknown }> {
  const run = harness(bytes, declared, door);
  const report = await run.verifier.verify();
  expect(report.failed).toBe(0);
  const metadata = run.audits.at(-1)?.['metadata'] as Record<string, unknown> | undefined;
  return {
    status: run.asset.status,
    code: run.asset.rejectionCode,
    kind: metadata?.['archive_entry_kind'],
  };
}

/** The entry the uploader is told about, read again from the stored object (the member's answer). */
async function namedEntry(bytes: Buffer, officeOpenXml = false): Promise<string | null> {
  const store = new FakeObjectStore(() => 0);
  store.objects.set('quarantine/k', bytes);
  const refusal = await inspectStoredArchive(
    store,
    { zone: 'quarantine', objectKey: 'k', sizeBytes: bytes.length },
    { channel: 'member', officeOpenXml },
  );
  return refusal?.entry ?? null;
}

describe('FIX5 M2/L3: the verifier reads what a ZIP holds', () => {
  it('refuses a ZIP with a program inside and names it', async () => {
    const bytes = zip([{ name: 'brief/readme.txt' }, { name: 'brief/setup.exe' }]);
    expect(await verdict(bytes)).toEqual({
      status: 'rejected',
      code: 'archive_contains_blocked',
      kind: 'executable',
    });
    expect(await namedEntry(bytes)).toBe('brief/setup.exe');
  });

  it('refuses a ZIP with a shortcut (.lnk) inside', async () => {
    const bytes = zip([{ name: 'Invoice.lnk' }]);
    expect((await verdict(bytes)).code).toBe('archive_contains_blocked');
    expect(await namedEntry(bytes)).toBe('Invoice.lnk');
  });

  it('refuses a ZIP with a script (.js) inside', async () => {
    const bytes = zip([{ name: 'update.js' }]);
    expect(await verdict(bytes)).toMatchObject({
      code: 'archive_contains_blocked',
      kind: 'executable',
    });
    expect(await namedEntry(bytes)).toBe('update.js');
  });

  it('refuses a ZIP with a macro document (.docm) inside', async () => {
    const bytes = zip([{ name: 'report.docm' }]);
    expect(await verdict(bytes)).toMatchObject({
      code: 'archive_contains_blocked',
      kind: 'macro_office',
    });
    expect(await namedEntry(bytes)).toBe('report.docm');
  });

  it('refuses a .docx that carries vbaProject.bin as macro Office (L3)', async () => {
    const bytes = zip([
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml' },
      { name: 'word/vbaProject.bin' },
    ]);
    expect(await verdict(bytes, 'member', DOCX)).toEqual({
      status: 'rejected',
      code: 'macro_office',
      kind: 'vba_project',
    });
    expect(await namedEntry(bytes, true)).toBe('word/vbaProject.bin');
  });

  it('refuses a double extension that ends in a program (invoice.pdf.exe)', async () => {
    const bytes = zip([{ name: 'docs/invoice.pdf.exe' }]);
    expect(await verdict(bytes)).toMatchObject({
      code: 'archive_contains_blocked',
      kind: 'double_extension',
    });
    expect(await namedEntry(bytes)).toBe('docs/invoice.pdf.exe');
  });

  it('refuses an archive inside the archive (one level only) and names the inner one', async () => {
    const bytes = zip([{ name: 'photos/a.jpg' }, { name: 'more/inner.zip' }]);
    expect(await verdict(bytes)).toMatchObject({ code: 'archive_nested', kind: 'archive' });
    expect(await namedEntry(bytes)).toBe('more/inner.zip');
    expect((await verdict(zip([{ name: 'backup.tar.gz' }]))).code).toBe('archive_nested');
  });

  it('passes a clean ZIP to the scan', async () => {
    const bytes = zip([
      { name: 'brief/' },
      { name: 'brief/plan.pdf' },
      { name: 'brief/photo.jpg' },
      { name: 'brief/sheet.xlsx' },
      { name: 'brief/printerSettings1.bin' },
    ]);
    expect(await verdict(bytes)).toEqual({ status: 'scanning', code: null, kind: undefined });
    // A clean OOXML document passes as well.
    const docx = zip([{ name: '[Content_Types].xml' }, { name: 'word/document.xml' }]);
    expect((await verdict(docx, 'member', DOCX)).status).toBe('scanning');
  });

  it('applies the same check to the client door, and refuses encrypted entries there only', async () => {
    expect((await verdict(zip([{ name: 'setup.exe' }]), 'client')).code).toBe(
      'archive_contains_blocked',
    );
    const locked = zip([{ name: 'secret/plan.pdf', encrypted: true }]);
    expect(await verdict(locked, 'client')).toMatchObject({
      status: 'rejected',
      code: 'archive_encrypted',
      kind: 'encrypted',
    });
    expect((await verdict(locked, 'member')).status).toBe('scanning');
  });

  it('refuses a ZIP-signed object whose directory cannot be read', async () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    expect((await verdict(broken)).code).toBe('archive_unreadable');
  });

  it('reads the directory from the tail when it starts before the last 64 KiB', async () => {
    const bytes = zip([
      { name: 'big.bin.dat', data: 'y'.repeat(200_000) },
      { name: 'tools/run.bat' },
    ]);
    expect(await namedEntry(bytes)).toBe('tools/run.bat');
  });

  it('caps and cleans the entry name it shows', () => {
    const long = `${'a/'.repeat(150)}setup.exe`;
    const shown = displayEntryPath(long);
    expect(shown.length).toBe(200);
    expect(shown.endsWith('setup.exe')).toBe(true);
    expect(displayEntryPath('‮exe.pdf')).toBe('exe.pdf');
    const refusal = judgeArchiveDirectory(readZipDirectory(zip([{ name: long }])), {
      channel: 'member',
      officeOpenXml: false,
    });
    expect(refusal?.entry).toBe(shown);
  });

  it("names the entry in the member's upload answer, never in the client's", async () => {
    const bytes = zip([{ name: 'brief/setup.exe' }]);
    const store = new FakeObjectStore(() => 0);
    store.objects.set('quarantine/k', bytes);
    const service = new FilesService(
      ...([
        {},
        {},
        {},
        {},
        null,
        {},
        {},
        store,
        {},
        null,
        null,
        null,
      ] as never as ConstructorParameters<typeof FilesService>),
    );
    const entryOf = (
      service as unknown as {
        rejectedEntryOf: (a: unknown, v: unknown, s: unknown) => Promise<string | null>;
      }
    ).rejectedEntryOf.bind(service);
    const asset = { status: 'rejected', rejectionCode: 'archive_contains_blocked', purgedAt: null };
    const version = { objectKey: 'k', sizeBytes: bytes.length };
    expect(await entryOf(asset, version, { clientOrganizationId: null })).toBe('brief/setup.exe');
    expect(await entryOf(asset, version, { clientOrganizationId: CLIENT_ORG })).toBeNull();
    expect(
      await entryOf({ ...asset, rejectionCode: 'type_mismatch' }, version, {
        clientOrganizationId: null,
      }),
    ).toBeNull();
  });
});
