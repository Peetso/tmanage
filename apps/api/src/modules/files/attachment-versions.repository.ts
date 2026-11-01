import { and, asc, eq, or } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { attachmentVersions } from '../../common/database/schema.js';
import type { AttachmentVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * C7 (0228) — the version chain of a plain attachment.
 *
 * `DeliverableVersionsRepository`'s shape: `TenantContext` scopes every query, no input carries
 * an `organizationId`, and a version is immutable — there is no `update` and no `delete`.
 * Version 1 is the root file asset itself and has no row here; rows are versions 2, 3 ….
 */

export interface CreateAttachmentVersionInput {
  readonly projectId: string;
  readonly rootFileAssetId: string;
  readonly fileAssetId: string;
  readonly versionNo: number;
  readonly note: string | null;
  readonly createdByUserId: string;
}

/**
 * R4 Batch F follow-up — a file's number in its chain from the row `findInvolving` returned: its
 * own row's `versionNo`, or 1 for the root (which has no row) and for a file with no chain.
 */
export function chainVersionNo(link: AttachmentVersionRow | null, fileAssetId: string): number {
  return link !== null && link.fileAssetId === fileAssetId ? link.versionNo : 1;
}

export class AttachmentVersionsRepository {
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateAttachmentVersionInput,
  ): Promise<AttachmentVersionRow> {
    const row: AttachmentVersionRow = {
      id: uuidv7(),
      organizationId: context.organizationId,
      projectId: input.projectId,
      rootFileAssetId: input.rootFileAssetId,
      fileAssetId: input.fileAssetId,
      versionNo: input.versionNo,
      note: input.note,
      createdByUserId: input.createdByUserId,
      createdAt: new Date(),
    };
    await tenantDrizzle(runner).insert(attachmentVersions).values(row);
    return row;
  }

  /** Versions 2, 3 … of one root asset, oldest first. */
  async listForRoot(
    runner: TenantQueryRunner,
    context: TenantContext,
    rootFileAssetId: string,
  ): Promise<readonly AttachmentVersionRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.organizationId, context.organizationId),
          eq(attachmentVersions.rootFileAssetId, rootFileAssetId),
        ),
      )
      .orderBy(asc(attachmentVersions.versionNo));
  }

  /**
   * The row that names this asset — as a later version, or as the root of a chain. `null` when
   * the asset takes part in no chain. A version's asset resolves to its root, so a caller holding
   * the id of version 3 reads the same history as one holding the original's.
   */
  async findInvolving(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<AttachmentVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.organizationId, context.organizationId),
          or(
            eq(attachmentVersions.fileAssetId, fileAssetId),
            eq(attachmentVersions.rootFileAssetId, fileAssetId),
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
