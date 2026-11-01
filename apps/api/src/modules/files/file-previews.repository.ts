import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { filePreviews } from '../../common/database/schema.js';
import type { FilePreviewRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * R4 slice 2 (0267) — the derivatives TManage makes of an uploaded version, and the queue the
 * preview job works from.
 *
 * `FileAssetsRepository`'s shape: `TenantContext` scopes every query, no input carries an
 * `organizationId`, and the one cross-tenant read ({@link organizationsWithPending}) goes through
 * the bootstrap runner, as the scan pass's does. The job's life of a row:
 *
 *     ensurePending → listPending → claim → markReady | markUnsupported | recordFailure
 *
 * - **Pending rows are idempotent.** `ensurePending` inserts the rows the kind map asks for and
 *   leaves any that already exist untouched (the unique key `(version, kind, page)`), so the
 *   `file.ready.v1` consumer can run twice.
 * - **A claim is conditional.** `claimed_at = now` on a pending row nobody holds — `claimed_at`
 *   NULL or older than the stale bound — and only at the attempt count the caller read, so two
 *   passes that selected the same row cannot both take it.
 * - **A failure keeps its claim.** `recordFailure` counts the attempt and leaves `claimed_at`
 *   standing, so the row waits out the stale bound before the next try (the scan pass's
 *   starvation lesson); at the last attempt it becomes `failed` with its code.
 * - **`ready` is written once.** `markReady` is conditional on the row still being `pending`;
 *   0267's trigger makes `object_key` write-once and pins the row's identity.
 *
 * `meta` comes back from MariaDB as text (its JSON is LONGTEXT); {@link parseMeta} turns it into
 * an object for every read here, so a caller never sees the difference.
 */

export const PREVIEW_KINDS = [
  'preview',
  'thumb',
  'page_thumb',
  'svg_safe',
  'psd_flat',
  'psd_layers',
  'pdf_meta',
  'office_meta',
  'media_meta',
  'zip_manifest',
  'poster',
] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export const PREVIEW_STATUSES = ['pending', 'ready', 'failed', 'unsupported'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/** The job's default attempt ceiling (SPEC R4 §3.5): `failed` after the third failure. */
export const PREVIEW_MAX_ATTEMPTS = 3;

export function isPreviewKind(value: string): value is PreviewKind {
  return (PREVIEW_KINDS as readonly string[]).includes(value);
}

export class InvalidPreviewKindError extends Error {
  constructor() {
    super('not a preview kind');
    this.name = 'InvalidPreviewKindError';
  }
}

/** A row as callers read it: `meta` parsed, `kind` and `status` narrowed. */
export interface FilePreview extends Omit<FilePreviewRow, 'meta' | 'kind' | 'status'> {
  readonly kind: PreviewKind;
  readonly status: PreviewStatus;
  readonly meta: Readonly<Record<string, unknown>> | null;
}

export interface PendingPreviewSpec {
  readonly kind: PreviewKind;
  /** 0 (the default) for a whole-file derivative; 1, 2 … for a per-page one. */
  readonly pageNo?: number;
}

export interface EnsurePendingInput {
  readonly fileAssetId: string;
  readonly fileVersionId: string;
  readonly previews: readonly PendingPreviewSpec[];
}

export interface ReadyPreviewInput {
  readonly objectKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly meta: Readonly<Record<string, unknown>> | null;
}

/** What a failure did to the row: still `pending` for another try, or now `failed`. */
export type FailureOutcome = 'retry' | 'failed' | 'not_pending';

/** MariaDB answers a JSON column as its text; MySQL and the fakes answer the object. */
export function parseMeta(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Readonly<Record<string, unknown>>;
}

function toPreview(row: FilePreviewRow): FilePreview {
  return {
    ...row,
    kind: row.kind as PreviewKind,
    status: row.status as PreviewStatus,
    meta: parseMeta(row.meta as unknown),
  };
}

function pageOf(spec: PendingPreviewSpec): number {
  const page = spec.pageNo ?? 0;
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('pageNo must be 0 or more');
  return page;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

/** A pending row nobody holds now: never claimed, or claimed by a pass older than the bound. */
function unclaimedOrStale(staleBefore: Date) {
  return or(isNull(filePreviews.claimedAt), lt(filePreviews.claimedAt, staleBefore));
}

export class FilePreviewsRepository {
  /**
   * Insert a `pending` row for each derivative the version needs, leaving existing rows as they
   * are. The duplicate-key branch rewrites `kind` to itself — a no-op the 0267 trigger accepts —
   * so a re-run of the consumer neither fails nor resets a row that is already `ready`.
   */
  async ensurePending(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: EnsurePendingInput,
    now: Date,
  ): Promise<void> {
    if (input.previews.length === 0) return;
    const rows = input.previews.map((spec) => {
      if (!isPreviewKind(spec.kind)) throw new InvalidPreviewKindError();
      return {
        id: uuidv7(),
        organizationId: context.organizationId,
        fileAssetId: input.fileAssetId,
        fileVersionId: input.fileVersionId,
        kind: spec.kind,
        pageNo: pageOf(spec),
        status: 'pending' as const,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
    });
    await tenantDrizzle(runner)
      .insert(filePreviews)
      .values(rows)
      .onDuplicateKeyUpdate({ set: { kind: sql`kind` } });
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<FilePreview | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(filePreviews)
      .where(and(eq(filePreviews.organizationId, context.organizationId), eq(filePreviews.id, id)))
      .limit(1);
    const row = rows[0];
    return row ? toPreview(row) : null;
  }

  /** Every derivative of one version, by kind then page. */
  async listForVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
  ): Promise<readonly FilePreview[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(filePreviews)
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.fileVersionId, fileVersionId),
        ),
      )
      .orderBy(asc(filePreviews.kind), asc(filePreviews.pageNo));
    return rows.map(toPreview);
  }

  /** Every derivative of every version of one asset — the viewer manifest's read. */
  async listForAsset(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<readonly FilePreview[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(filePreviews)
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.fileAssetId, fileAssetId),
        ),
      )
      .orderBy(asc(filePreviews.fileVersionId), asc(filePreviews.kind), asc(filePreviews.pageNo));
    return rows.map(toPreview);
  }

  /**
   * The rows one preview pass should look at in this organization: `pending`, held by nobody
   * (or by a pass older than `staleBefore`), oldest first so a stuck row is never starved.
   */
  async listPending(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly FilePreview[]> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(filePreviews)
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.status, 'pending'),
          unclaimedOrStale(staleBefore),
        ),
      )
      .orderBy(asc(filePreviews.createdAt), asc(filePreviews.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(toPreview);
  }

  /** The preview pass's cross-tenant half, through the bootstrap runner as the scan pass's is. */
  async organizationsWithPending(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: filePreviews.organizationId })
      .from(filePreviews)
      .where(and(eq(filePreviews.status, 'pending'), unclaimedOrStale(staleBefore)))
      .orderBy(asc(filePreviews.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * Take a pending row for this pass: `claimed_at = now`, conditional on the row still being
   * pending, unheld (or stale) and at the attempt count the caller read. `true` when this call
   * took it.
   */
  async claim(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: Pick<FilePreview, 'id' | 'attempts'>,
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(filePreviews)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.id, row.id),
          eq(filePreviews.status, 'pending'),
          eq(filePreviews.attempts, row.attempts),
          unclaimedOrStale(staleBefore),
        ),
      );
    return affected(result) === 1;
  }

  /**
   * Record the derivative the generator wrote: `ready`, with where the bytes are and what they
   * are. Conditional on the row still being `pending`, so a pass that lost its claim to a stale
   * re-take cannot overwrite what the other wrote. `true` when this call wrote it.
   */
  async markReady(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: ReadyPreviewInput,
    now: Date,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new RangeError('sizeBytes must be a non-negative integer');
    }
    const result = await tenantDrizzle(runner)
      .update(filePreviews)
      .set({
        status: 'ready',
        objectKey: input.objectKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        width: input.width,
        height: input.height,
        meta: input.meta === null ? null : { ...input.meta },
        errorCode: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.id, id),
          eq(filePreviews.status, 'pending'),
        ),
      );
    return affected(result) === 1;
  }

  /**
   * The generator cannot make this derivative here (too large, a format it does not read): the
   * row is `unsupported` at once, with the code the viewer shows a reason for. No retry.
   */
  async markUnsupported(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    errorCode: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(filePreviews)
      .set({
        status: 'unsupported',
        errorCode: errorCode.slice(0, 64),
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.id, id),
          eq(filePreviews.status, 'pending'),
        ),
      );
    return affected(result) === 1;
  }

  /**
   * Count a failed attempt. Below the ceiling the row stays `pending` and **keeps its claim**, so
   * it waits out the stale bound before the next try; at the ceiling it becomes `failed` with its
   * code. Conditional on the attempt count the caller read, so two reports of one attempt count once.
   */
  async recordFailure(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: Pick<FilePreview, 'id' | 'attempts'>,
    errorCode: string,
    now: Date,
    maxAttempts: number = PREVIEW_MAX_ATTEMPTS,
  ): Promise<FailureOutcome> {
    const attempts = row.attempts + 1;
    const final = attempts >= maxAttempts;
    const result = await tenantDrizzle(runner)
      .update(filePreviews)
      .set({
        attempts,
        errorCode: errorCode.slice(0, 64),
        updatedAt: now,
        ...(final ? { status: 'failed', claimedAt: null } : {}),
      })
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.id, row.id),
          eq(filePreviews.status, 'pending'),
          eq(filePreviews.attempts, row.attempts),
        ),
      );
    if (affected(result) !== 1) return 'not_pending';
    return final ? 'failed' : 'retry';
  }

  /**
   * The viewer's "Try again": every `failed` derivative of the asset goes back to `pending` with a
   * fresh attempt budget and no claim. `unsupported` rows stay — trying again changes nothing for
   * them. Answers how many rows were reset.
   */
  async resetFailed(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
    now: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(filePreviews)
      .set({ status: 'pending', attempts: 0, errorCode: null, claimedAt: null, updatedAt: now })
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          eq(filePreviews.fileAssetId, fileAssetId),
          eq(filePreviews.status, 'failed'),
        ),
      );
    return affected(result);
  }

  /**
   * Remove rows by id (the orphan sweep, after their bytes are deleted from the `derived` zone).
   * Answers how many went.
   */
  async deleteByIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tenantDrizzle(runner)
      .delete(filePreviews)
      .where(
        and(
          eq(filePreviews.organizationId, context.organizationId),
          inArray(filePreviews.id, [...ids]),
        ),
      );
    return affected(result);
  }
}
