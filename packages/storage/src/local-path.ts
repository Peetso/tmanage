/**
 * Object key to filesystem path, for the `local` driver — production uploads on a single host.
 *
 * A key is a path. On a bucket that is only a naming convention; on a disk it is the whole
 * security boundary, because `path.resolve(root, key)` will happily walk out of the root on a
 * `..`, jump to another drive on `C:`, or follow a symlink planted inside it. `object-key.ts`
 * is the first line of defence: it only ever builds keys from checked UUIDs. This module is
 * the second, for every key that reaches the disk by any route — a manifest read back, a row,
 * a caller that did not go through `uploadObjectKey`:
 *
 * - `assertSafeObjectKey` refuses anything that is not plain `/`-separated, conservative
 *   segments: no NUL or control characters, no backslash, no absolute or drive-letter form,
 *   no empty, `.` or `..` segment.
 * - `resolveUnder` resolves the segments and requires the result to sit strictly beneath the
 *   base — never the base itself, never a sibling that merely shares its prefix.
 * - `assertRealPathUnder` repeats that check on real paths, so a symlinked directory inside
 *   the root cannot carry a write or a read outside it.
 * - `tenantOfObjectKey` / `assertTenantKey` tie a key to the organization that asks for it.
 *
 * Every refusal is `UnsafeObjectPathError('objectKey')`; the key itself is never repeated.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { UnsafeObjectPathError } from './errors.js';

/** One path segment: starts with an alphanumeric, then a conservative set, at most 128 chars. */
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MAX_KEY_LENGTH = 1024;
const DRIVE_LETTER = /^[A-Za-z]:/;
const TENANT_PREFIX = /^tenant\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

function unsafe(): UnsafeObjectPathError {
  return new UnsafeObjectPathError('objectKey');
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Refuses a key that is not plain, relative, `/`-separated safe segments; returns them. */
export function assertSafeObjectKey(key: string): readonly string[] {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) throw unsafe();
  if (hasControlCharacter(key) || key.includes('\\')) throw unsafe();
  if (key.startsWith('/') || DRIVE_LETTER.test(key)) throw unsafe();
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || !SAFE_SEGMENT.test(segment)) {
      throw unsafe();
    }
  }
  return segments;
}

/** The resolved path of `segments` under `base`, which must lie strictly beneath it. */
export function resolveUnder(base: string, segments: readonly string[]): string {
  const b = path.resolve(base);
  const p = path.resolve(b, ...segments);
  if (!p.startsWith(b + path.sep)) throw unsafe();
  return p;
}

async function realpathOfDeepestExisting(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Refuses `target` when the real path of its deepest existing ancestor is not `base` or
 * beneath it — the case `resolveUnder` cannot see: a symlinked directory inside the root.
 */
export async function assertRealPathUnder(base: string, target: string): Promise<void> {
  const realBase = await realpath(base);
  const realTarget = await realpathOfDeepestExisting(target);
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) throw unsafe();
}

/** The organization uuid a `tenant/{uuid}/...` key belongs to, or null for any other key. */
export function tenantOfObjectKey(key: string): string | null {
  const match = TENANT_PREFIX.exec(key);
  return match?.[1] ?? null;
}

/** Refuses a key that does not belong to `organizationId`. */
export function assertTenantKey(key: string, organizationId: string): void {
  if (tenantOfObjectKey(key) !== organizationId) throw unsafe();
}
