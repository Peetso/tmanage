import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { FileAssetRow, FileVersionRow } from '../../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { FileScanSource } from './file-scan-source.js';

/**
 * 62-25 — the scan read's byte door: only the asset's current servable version (AR-8), only a
 * PDF, within the size cap and the page cap; the bytes leave as base64 with their page count.
 */

const ORG = '0190a3e4-0000-7000-8000-0000000000c1';
const CONTEXT = { organizationId: ORG } as TenantContext;

const database = {
  read: (_c: unknown, work: (db: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

async function blankPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage([200, 200]);
  return pdf.save();
}

function setup(
  bytes: Uint8Array,
  assetOverrides: Partial<FileAssetRow> = {},
  versionOverrides: Partial<FileVersionRow> = {},
  maxBytes?: number,
) {
  const asset = {
    id: 'f1',
    organizationId: ORG,
    status: 'ready',
    deletedAt: null,
    purgedAt: null,
    ...assetOverrides,
  } as FileAssetRow;
  const version = {
    id: 'v1',
    organizationId: ORG,
    fileAssetId: 'f1',
    scanVerdict: 'clean',
    trustZone: 'private',
    detectedMimeType: 'application/pdf',
    sizeBytes: bytes.byteLength,
    objectKey: 'k/v1',
    storageBackend: 'local',
    ...versionOverrides,
  } as FileVersionRow;
  const opened: string[] = [];
  const source = new FileScanSource(
    database,
    { findById: () => Promise.resolve(asset) },
    { currentVersion: () => Promise.resolve(version) },
    {
      openObject: (input: { objectKey: string }) => {
        opened.push(input.objectKey);
        return Promise.resolve({
          sizeBytes: bytes.byteLength,
          stream: Readable.from([Buffer.from(bytes)]),
        });
      },
    } as never,
    {},
    maxBytes,
  );
  return { source, opened };
}

describe('the scan byte door (62-25)', () => {
  it('returns the PDF as base64 with its page count', async () => {
    const bytes = await blankPdf(3);
    const { source } = setup(bytes);
    expect(await source.read(CONTEXT, 'f1', 30)).toEqual({
      ok: true,
      data: Buffer.from(bytes).toString('base64'),
      pages: 3,
    });
  });

  it('refuses before reading a byte: not servable, not a PDF, too large', async () => {
    const bytes = await blankPdf(1);
    const cases: [string, ReturnType<typeof setup>, string][] = [
      ['rejected asset', setup(bytes, { status: 'rejected' }), 'not_servable'],
      ['deleted asset', setup(bytes, { deletedAt: new Date() }), 'not_servable'],
      ['quarantined version', setup(bytes, {}, { trustZone: 'quarantine' }), 'not_servable'],
      ['not a PDF', setup(bytes, {}, { detectedMimeType: 'image/png' }), 'not_pdf'],
      ['over the size cap', setup(bytes, {}, {}, 10), 'too_large'],
    ];
    for (const [why, { source, opened }, code] of cases) {
      expect(await source.read(CONTEXT, 'f1', 30), why).toEqual({ ok: false, code });
      expect(opened, why).toEqual([]);
    }
  });

  it('refuses a PDF over the page cap', async () => {
    const { source } = setup(await blankPdf(4));
    expect(await source.read(CONTEXT, 'f1', 3)).toEqual({ ok: false, code: 'too_many_pages' });
  });

  it('refuses bytes that do not match the stored size', async () => {
    const bytes = await blankPdf(1);
    const { source } = setup(bytes, {}, { sizeBytes: bytes.byteLength + 1 });
    expect(await source.read(CONTEXT, 'f1', 30)).toEqual({ ok: false, code: 'unreadable' });
  });
});
