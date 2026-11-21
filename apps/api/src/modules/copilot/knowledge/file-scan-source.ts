import { isServableVersion } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import type { ObjectStore } from '@tmanage/storage';
import type { FileAssetsRepository } from '../../files/file-assets.repository.js';
import type { FileKnowledgeRepository } from './file-knowledge.repository.js';
import { DEFAULT_TEXT_LIMITS } from '../../files/file-text-extractors.js';
import { VersionStore } from '../../files/provider-objects.js';
import type { ProviderObjectSources } from '../../files/provider-objects.js';

/**
 * 62-25 — the bytes of a scanned PDF for the one turn in which the member accepted "read the scan
 * with AI" (plan 62 §4.5: Sonnet reads a scan only when the member accepted the estimate). Nothing
 * else calls it: the text job never sends a byte anywhere, and the file route only reports a scan.
 *
 * The same door as every read of a file's bytes (AR-8): the asset's current version is re-read
 * here and must be servable (`isServableVersion`: asset `ready`, version `clean`, promoted to
 * `private`), a PDF, within the text job's size cap (ST-1, 20 MB) and at most `maxPages` pages
 * (counted with the PDF reader the text job uses). The caller has already checked, through the
 * member's own route in the same turn, that the member may open the file.
 */

export type ScanSourceResult =
  | { readonly ok: true; readonly data: string; readonly pages: number }
  | {
      readonly ok: false;
      readonly code: 'not_servable' | 'not_pdf' | 'too_large' | 'too_many_pages' | 'unreadable';
    };

const PDF_MIME = 'application/pdf';

export class FileScanSource {
  private readonly versions: VersionStore;

  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: Pick<FileAssetsRepository, 'findById'>,
    private readonly files: Pick<FileKnowledgeRepository, 'currentVersion'>,
    store: Pick<ObjectStore, 'openObject'>,
    providers: ProviderObjectSources = {},
    private readonly maxBytes: number = DEFAULT_TEXT_LIMITS.maxInputBytes,
  ) {
    this.versions = new VersionStore(store, providers);
  }

  async read(
    context: TenantContext,
    fileAssetId: string,
    maxPages: number,
  ): Promise<ScanSourceResult> {
    const found = await this.database.read(context, async (db) => {
      const asset = await this.assets.findById(db, context, fileAssetId);
      const version = await this.files.currentVersion(db, context, fileAssetId);
      return { asset, version };
    });
    const { asset, version } = found;
    if (
      asset === null ||
      version === null ||
      asset.deletedAt !== null ||
      asset.purgedAt !== null ||
      !isServableVersion({
        status: asset.status,
        scanVerdict: version.scanVerdict,
        trustZone: version.trustZone,
      })
    ) {
      return { ok: false, code: 'not_servable' };
    }
    if (version.detectedMimeType !== PDF_MIME) return { ok: false, code: 'not_pdf' };
    if (version.sizeBytes > this.maxBytes) return { ok: false, code: 'too_large' };
    let bytes: Buffer;
    try {
      const opened = await this.versions.open(context, version, 'private');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const piece of opened.stream) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
        total += chunk.length;
        if (total > version.sizeBytes) return { ok: false, code: 'unreadable' };
        chunks.push(chunk);
      }
      if (total !== version.sizeBytes) return { ok: false, code: 'unreadable' };
      bytes = Buffer.concat(chunks, total);
    } catch {
      return { ok: false, code: 'unreadable' };
    }
    const pages = await pageCount(bytes);
    if (pages === null) return { ok: false, code: 'unreadable' };
    if (pages > maxPages) return { ok: false, code: 'too_many_pages' };
    return { ok: true, data: bytes.toString('base64'), pages };
  }
}

/** The page count of a PDF, through the reader the text job uses; `null` when it cannot be read. */
export async function pageCount(bytes: Uint8Array): Promise<number | null> {
  const { getDocumentProxy } = await import('unpdf');
  try {
    // PDF.js takes ownership of the buffer it is given: hand it a copy.
    const document = (await getDocumentProxy(new Uint8Array(bytes))) as unknown as {
      readonly numPages: number;
      destroy?(): Promise<void>;
      cleanup?(): Promise<void>;
    };
    const pages = document.numPages;
    await (document.destroy ?? document.cleanup)?.call(document).catch(() => undefined);
    return pages;
  } catch {
    return null;
  }
}
