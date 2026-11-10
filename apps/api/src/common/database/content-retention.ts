import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { QueryRows, TenantQueryRunner } from './tenant-context.js';

/**
 * platform-admin v2 · PA-03 — the content restore window (SPEC P7, migration 0245).
 *
 * Deleting a message, comment, document, decision, meeting, file or attachment no longer removes
 * the row: it sets `deleted_at`, `deleted_by_user_id`, `deleted_reason` and `purge_after`. The row
 * leaves every list at once, stays readable by id (so `authorize()`'s `lifecycle: 'soft_deleted'`
 * refuses writes to it), can be restored until `purge_after`, and the worker's `--sweep-purge`
 * removes it afterwards.
 *
 * The window is `platform_settings['retention.content_purge_days']` when a Platform admin set it,
 * otherwise {@link DEFAULT_CONTENT_PURGE_DAYS}. Read through the tenant runner (`platform_settings`
 * is a global table the guard admits) and cached for 30 seconds per process, so a delete costs one
 * extra primary-key read at most twice a minute. This file never touches `billing-mode.ts`.
 */

export const DEFAULT_CONTENT_PURGE_DAYS = 30;
export const CONTENT_PURGE_DAYS_SETTING = 'retention.content_purge_days';
/** The longest window a setting may ask for; anything above is clamped (one year). */
export const MAX_CONTENT_PURGE_DAYS = 365;
const CACHE_MS = 30_000;

let cached: { readonly days: number; readonly at: number } | null = null;

/** Parse a stored setting value; anything that is not a whole number of days falls back. */
export function parsePurgeDays(value: unknown): number {
  const text =
    typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!/^\d{1,4}$/u.test(text)) return DEFAULT_CONTENT_PURGE_DAYS;
  const days = Number(text);
  if (days < 1) return DEFAULT_CONTENT_PURGE_DAYS;
  return Math.min(days, MAX_CONTENT_PURGE_DAYS);
}

/** The current restore window in days (30 s cache). A failed read keeps the default. */
export async function contentPurgeDays(
  runner: TenantQueryRunner,
  now: number = Date.now(),
): Promise<number> {
  if (cached && now - cached.at < CACHE_MS) return cached.days;
  let days = DEFAULT_CONTENT_PURGE_DAYS;
  try {
    const rows = await runner.execute<QueryRows>(
      'SELECT setting_value FROM platform_settings WHERE setting_key = ?',
      [CONTENT_PURGE_DAYS_SETTING],
    );
    const row = rows[0];
    if (row) days = parsePurgeDays(row['setting_value']);
  } catch {
    // The setting is optional; the default window is the safe answer when it cannot be read.
    days = DEFAULT_CONTENT_PURGE_DAYS;
  }
  cached = { days, at: now };
  return days;
}

/** Test seam: forget the cached window. */
export function resetContentPurgeDaysCache(): void {
  cached = null;
}

/** The four column values a soft delete writes, for Drizzle's `.set({...})`. */
export interface SoftDeleteValues {
  readonly deletedAt: SQL;
  readonly deletedByUserId: string | null;
  readonly deletedReason: string | null;
  readonly purgeAfter: SQL;
}

/**
 * FIX5 security review M1. The `deleted_reason` a member's delete from Files, chat or the viewer
 * writes. Undo (`POST …/files/:fileId/restore`) brings back only a row carrying exactly this
 * marker; a platform takedown or any other removal never carries it (the platform path refuses
 * to write it, see {@link platformDeletedReason}), so it is restored only from the platform side.
 */
export const FILES_USER_DELETE_REASON = 'files:user_delete';

/**
 * A platform or moderation removal's reason, normalised, never the Files marker: a reason typed
 * as the marker is kept as text but prefixed, so the uploader's Undo cannot reverse a takedown.
 */
export function platformDeletedReason(reason: string | null | undefined): string | null {
  const normalised = normaliseDeletedReason(reason);
  return normalised === FILES_USER_DELETE_REASON ? `platform: ${normalised}` : normalised;
}

/** The longest reason a row keeps (the column is VARCHAR(500)). */
export const MAX_DELETED_REASON = 500;

/** Normalise a reason: trimmed, empty → null, capped at {@link MAX_DELETED_REASON}. */
export function normaliseDeletedReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_DELETED_REASON);
}

/**
 * The values of one soft delete: now (database clock), the actor, the optional reason, and
 * `purge_after = now + window`. A caller that passes no reason (every controller today) gets NULL.
 */
export async function softDeleteValues(
  runner: TenantQueryRunner,
  deletedByUserId: string | null,
  reason?: string | null,
): Promise<SoftDeleteValues> {
  const days = await contentPurgeDays(runner);
  return {
    deletedAt: sql`current_timestamp(3)`,
    deletedByUserId,
    deletedReason: normaliseDeletedReason(reason),
    purgeAfter: sql`current_timestamp(3) + interval ${days} day`,
  };
}

/** The values of a restore: every soft-delete column back to NULL. */
export const RESTORE_VALUES = {
  deletedAt: null,
  deletedByUserId: null,
  deletedReason: null,
  purgeAfter: null,
} as const;
