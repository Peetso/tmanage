import { readZipDirectory, ZipReadError } from './zip-reader.js';
import type { ZipLimits } from './zip-reader.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome } from './types.js';

/**
 * R4 slice 10 — the ZIP list (`zip_manifest`, facts only). The archive's table of contents is
 * read; nothing is extracted, inflated or served (SPEC R4 §2). The viewer draws the folder tree
 * with sizes and dates, says "Nothing is extracted — download the ZIP to open these files", and
 * takes general (whole-file) comments only.
 *
 * Caps (env `PREVIEW_ZIP_MAX_ENTRIES`, default 5 000; declared unpacked total ≤ 2 GB): above them
 * the row is `unsupported: unsupported_zip_bomb`. An encrypted archive still lists its names.
 */

const ZIP = 'application/zip';

/** One line of the stored list: files and the folders they imply. */
export interface ZipListEntry {
  readonly path: string;
  readonly folder: boolean;
  readonly sizeBytes: number;
  readonly modifiedAt: string | null;
}

export interface ZipFacts {
  readonly entries: readonly ZipListEntry[];
  readonly fileCount: number;
  readonly folderCount: number;
  readonly totalBytes: number;
  readonly compressedBytes: number;
  readonly encrypted: boolean;
}

function zipLimits(): ZipLimits {
  const raw = Number.parseInt(process.env['PREVIEW_ZIP_MAX_ENTRIES'] ?? '', 10);
  return {
    maxEntries: Number.isSafeInteger(raw) && raw > 0 ? raw : 5000,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
  };
}

/** Folder paths implied by file paths (`a/b/c.txt` → `a/`, `a/b/`), so the tree is whole. */
function impliedFolders(paths: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').filter((part) => part.length > 0);
    const last = path.endsWith('/') ? parts.length : parts.length - 1;
    for (let depth = 1; depth <= last; depth += 1) {
      folders.add(`${parts.slice(0, depth).join('/')}/`);
    }
  }
  return folders;
}

/** Names the list must not show: macOS resource forks and absolute / parent-walking paths. */
function hidden(path: string): boolean {
  return path.startsWith('__MACOSX/') || path.split('/').some((part) => part === '.DS_Store');
}

function clean(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 500);
}

export function zipFactsFrom(bytes: Uint8Array, limits: ZipLimits = zipLimits()): ZipFacts {
  const directory = readZipDirectory(bytes, limits);
  const files: ZipListEntry[] = [];
  let compressed = 0;
  let encrypted = false;
  for (const entry of directory.entries) {
    compressed += entry.compressedBytes;
    encrypted ||= entry.encrypted;
    if (entry.folder || hidden(entry.path)) continue;
    const path = clean(entry.path);
    if (path === '') continue;
    files.push({ path, folder: false, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt });
  }
  const folders = [...impliedFolders(files.map((file) => file.path))].map((path): ZipListEntry => ({
    path,
    folder: true,
    sizeBytes: 0,
    modifiedAt: null,
  }));
  const entries = [...folders, ...files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries,
    fileCount: files.length,
    folderCount: folders.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    compressedBytes: compressed,
    encrypted,
  };
}

export const zipGenerator: PreviewGenerator = {
  name: 'zip',
  mimeTypes: [ZIP],
  plan() {
    return [{ kind: 'zip_manifest' }];
  },
  async generate(source, requests) {
    let facts: ZipFacts | PreviewOutcome;
    try {
      facts = zipFactsFrom(source.bytes);
    } catch (error) {
      if (error instanceof ZipReadError && error.code === 'zip_bomb') {
        facts = unsupported('unsupported_zip_bomb');
      } else {
        facts = failed('zip_unreadable');
      }
    }
    return requests.map((request): PreviewOutcome => {
      if (request.kind !== 'zip_manifest') return unsupported('kind_not_zip');
      if ('status' in facts) return facts;
      return {
        status: 'ready',
        body: null,
        mimeType: null,
        width: null,
        height: null,
        meta: { ...facts },
      };
    });
  },
};
