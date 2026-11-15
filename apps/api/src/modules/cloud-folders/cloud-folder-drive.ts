import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FetchedCloudFile } from '../../common/storage/cloud-fetch.js';

/**
 * FIX6 C3. What the cloud-folder service asks of a storage provider: describe a folder before it
 * is attached, list its children live, and fetch one child after the server has checked the child
 * sits inside the attached folder. Each provider service implements it with the company
 * connection; the token never leaves that service.
 */

export type CloudFolderProvider = 'google_drive' | 'onedrive';

/** The attached folder, as the provider names it. `driveId` is OneDrive's drive; null for Drive. */
export interface CloudFolderRef {
  readonly driveId: string | null;
  readonly folderId: string;
}

/** One entry of a live listing: never a download link, never a token. */
export interface CloudFolderChild {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly isFolder: boolean;
}

export interface CloudFolderPage {
  readonly files: readonly CloudFolderChild[];
  readonly nextPageToken: string | null;
}

export interface CloudFolderDrive {
  /**
   * The folder's name, for attaching it to a work item of `projectId`. Refuses (404) a folder that
   * is, or holds, another project's TManage folders or the TManage root.
   */
  describeFolder(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    ref: CloudFolderRef,
  ): Promise<{ readonly name: string }>;
  /** One page of the folder's children, or of a subfolder proven to be inside it. */
  listFolder(
    context: TenantContext,
    ref: CloudFolderRef,
    input: { readonly parentId: string | null; readonly pageToken: string | null },
  ): Promise<CloudFolderPage>;
  /** A child's metadata (its modified time keys the checked copy), once proven inside (404). */
  inspectChild(
    context: TenantContext,
    ref: CloudFolderRef,
    childId: string,
  ): Promise<CloudFolderChild>;
  /** A child's bytes, at most `maxBytes`, only once it is proven to be inside the folder (404). */
  fetchFromFolder(
    context: TenantContext,
    ref: CloudFolderRef,
    childId: string,
    maxBytes: number,
  ): Promise<FetchedCloudFile>;
}

/** How far up a child's ancestry the descendant check walks before refusing. */
export const MAX_FOLDER_DEPTH = 20;
/** Drive may report more than one parent; only this many are followed per level. */
const MAX_LEVEL_BREADTH = 4;

/**
 * Is `folderId` an ancestor of an item whose own parents are `startParents`? The walk asks
 * `parentsOf` one level at a time, at most {@link MAX_FOLDER_DEPTH} levels, and never revisits an
 * id (a cycle cannot hold it). An ancestor the provider will not show (`parentsOf` answers `[]`)
 * ends that branch. Running out of levels is a refusal: fail closed.
 */
export async function isInsideFolder(
  folderId: string,
  startParents: readonly string[],
  parentsOf: (id: string) => Promise<readonly string[]>,
  maxLevels: number = MAX_FOLDER_DEPTH,
): Promise<boolean> {
  const seen = new Set<string>();
  let level = [...new Set(startParents)].slice(0, MAX_LEVEL_BREADTH);
  for (let depth = 0; depth < maxLevels && level.length > 0; depth += 1) {
    if (level.includes(folderId)) return true;
    const next = new Set<string>();
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const parent of await parentsOf(id)) {
        if (!seen.has(parent) && next.size < MAX_LEVEL_BREADTH) next.add(parent);
      }
    }
    level = [...next];
  }
  return false;
}
